import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchRoute } from '../src/handlers.js';
import { burnWindows, loadSlo, renderCapacityTfvars, renderClassMap, renderK6, renderAlerts, renderQueries } from '../scripts/generate-slo.js';
import { ratioExpr, renderLocals } from '../scripts/generate-slo.js';

const HERE = new URL('..', import.meta.url).pathname;

test('burn windows scale with the SLO window, multipliers do not', () => {
  // The Google reference: a 30-day window pages at 14.4x over 1h and tickets at
  // 6x over 6h. Those encode "2% of budget" and "5% of budget" respectively.
  const thirtyDays = burnWindows(30 * 86400);
  assert.equal(thirtyDays.fast.multiplier, 14.4);
  assert.equal(thirtyDays.fast.window, '1h');
  assert.equal(thirtyDays.slow.multiplier, 6);
  assert.equal(thirtyDays.slow.window, '6h');

  // A 3-day window is 1/10th, so the alert windows are 1/10th and the budget
  // fractions are preserved. Multipliers are invariant.
  const threeDays = burnWindows(3 * 86400);
  assert.equal(threeDays.fast.multiplier, 14.4);
  assert.equal(threeDays.fast.window, '6m');
  assert.equal(threeDays.slow.multiplier, 6);
  assert.equal(threeDays.slow.window, '36m');
});

test('a mix that does not sum to 1.0 is refused', () => {
  assert.throws(
    () => loadSlo(null, { service: 's', window: '30d', slos: [], capacity: {
      target_rps: 1000, mix: { read: 0.5, write: 0.1 }, cost_per_request: {},
    } }),
    /mix must sum to 1\.0/,
  );
});

test('an endpoint in two classes is refused', () => {
  assert.throws(
    () => loadSlo(null, { service: 's', window: '30d', capacity: null, slos: [{
      name: 'l', sli: 'class_threshold_ratio', objective: 99, tail_objective: 99.9,
      tail_multiplier: 3,
      classes: { fast: { threshold_ms: 50, endpoints: ['feed'] },
                 standard: { threshold_ms: 200, endpoints: ['feed'] } },
    }] }),
    /endpoint "feed" appears in more than one class/,
  );
});

test('regenerating the committed slo.yaml reproduces the committed outputs byte for byte', () => {
  const model = loadSlo(`${HERE}slo.yaml`);
  assert.equal(renderK6(model), readFileSync(`${HERE}k6/lib/slo.js`, 'utf8'));
  assert.equal(renderCapacityTfvars(model), readFileSync(`${HERE}terraform/capacity.auto.tfvars`, 'utf8'));
});

test('the committed slo.yaml is a 7-day window with 14m/84m burn alerting', () => {
  // 7d is the intersection of two hard limits, not a preference. Grafana's SLO
  // API refuses anything outside 7-32 days ("Use time window of at least 7 days
  // and at most 32 days"), and Grafana Cloud Free retains metrics for 14 days,
  // so a longer window could never be evaluated over the period it claims.
  const model = loadSlo(`${HERE}slo.yaml`);
  assert.equal(model.window, '7d');
  assert.equal(model.windowSeconds, 604800);
  assert.equal(model.burn.fast.window, '14m');
  assert.equal(model.burn.fast.forDuration, '70s');
  assert.equal(model.burn.slow.window, '84m');
  assert.equal(model.burn.slow.forDuration, '7m');
});

test('every generated burn duration is a duration the grafana provider accepts', () => {
  // 7d/30d scales 300s to 70s -- not a whole minute. The renderer must emit "70s"
  // and never a fraction like "1.17m", which the provider's regex rejects.
  const model = loadSlo(`${HERE}slo.yaml`);
  const valid = /^\d+(ms|s|m|h|d|w|y)$/;
  for (const burn of Object.values(model.burn)) {
    assert.match(burn.window, valid);
    assert.match(burn.forDuration, valid);
  }
});

test('every endpoint in slo.yaml maps to a route template that handlers.js serves', () => {
  const model = loadSlo(`${HERE}slo.yaml`);
  for (const [name, template] of Object.entries(model.endpoints)) {
    // Rebuild a concrete path from the template so matchRoute can be asked
    // whether this route still exists under that exact name.
    const concrete = template.replace(/:[^/]+/g, 'x');
    const method = template === '/items' || template === '/reports' ? 'POST' : 'GET';
    const hit = matchRoute(method, concrete);
    assert.ok(hit, `slo.yaml names endpoint "${name}" at ${template}, which handlers.js does not serve`);
    assert.equal(hit.template, template);
    assert.equal(hit.name, name);
  }
});

test('every class member is a declared endpoint', () => {
  const model = loadSlo(`${HERE}slo.yaml`);
  const slo = model.slos.find((s) => s.sli === 'class_threshold_ratio');
  for (const cls of Object.values(slo.classes)) {
    for (const endpoint of cls.endpoints) {
      assert.ok(model.endpoints[endpoint], `class references undeclared endpoint "${endpoint}"`);
    }
  }
});

test('the class map is keyed by route template, not endpoint name', () => {
  const map = JSON.parse(renderClassMap(loadSlo(`${HERE}slo.yaml`)));
  assert.deepEqual(map, {
    '/items/:pk/:sk': 'fast',
    '/items': 'fast',
    '/feeds/:pk': 'standard',
    '/reports': 'heavy',
  });
  // /healthz is absent on purpose: it is emitted but unclassified, and the SLO
  // query excludes it by selector (spec S15).
  assert.equal(map['/healthz'], undefined);
});

test('queries.json carries one query per attribution key, all non-empty', () => {
  const doc = loadSlo(`${HERE}slo.yaml`);
  const q = JSON.parse(renderQueries(doc));
  for (const key of [
    'sli_ratio', 'db_wall_avg_by_route', 'cloudwatch_srl_by_operation',
    'queueing_ms_by_route', 'cpu_seconds_per_second', 'cpu_saturation_ratio',
    'eventloop_delay_p99', 'eventloop_utilization',
    'read_throttle_events', 'write_throttle_events',
  ]) {
    assert.ok(q[key] && q[key].trim().length > 0, `${key} missing from queries.json`);
  }
});

// ThrottledRequests is published ONLY with a TableName+Operation dimension pair, and its
// per-60s gauge reads 0 at instants during sustained throttling -- measured 2026-09-01 as
// "... 4156, 0, 4153, 4360 ..." while DynamoDB was rejecting 5588 reads/minute. Read and
// write throttle events are published at table level, continuously, and separate the two
// sides. See docs/superpowers/specs/2026-09-01-...-attribution-simplified-design.md.
test('queries.json does not offer ThrottledRequests as a signal', () => {
  const q = JSON.parse(renderQueries(loadSlo(`${HERE}slo.yaml`)));
  assert.equal(q.throttled_requests, undefined,
    'throttled_requests must not be reintroduced');
  for (const [key, expr] of Object.entries(q)) {
    assert.ok(!expr.includes('throttled_requests_sum'),
      `${key} still reads aws_dynamodb_throttled_requests_sum`);
  }
});

test('throttle-event queries read the gauge directly and are never rated', () => {
  const q = JSON.parse(renderQueries(loadSlo(`${HERE}slo.yaml`)));
  for (const key of ['read_throttle_events', 'write_throttle_events']) {
    assert.ok(!q[key].includes('rate('),
      `${key} wraps a per-60s CloudWatch gauge in rate(); every decrease reads as a counter reset`);
    assert.ok(q[key].includes('dimension_TableName="ecs-dynamodb-rps-ceiling"'),
      `${key} is not scoped to this project's table`);
  }
});

const classifiedEndpoints = (doc) => Object.values(
  doc.slos.find((s) => s.sli === 'class_threshold_ratio').classes,
).flatMap((c) => c.endpoints);

test('every classified route has a DynamoDB operation mapping', () => {
  const doc = loadSlo(`${HERE}slo.yaml`);
  for (const endpoint of classifiedEndpoints(doc)) {
    assert.ok(doc.attribution.operations[endpoint],
      `${endpoint} is classified but has no attribution.operations entry`);
  }
});

test('a classified endpoint with no operations entry is refused, not rendered', () => {
  // The mapping merely EXISTING is not the property that matters -- the previous
  // version of this file asserted only that, which is why a queueing query that
  // never read the map shipped green.
  const doc = loadSlo(`${HERE}slo.yaml`);
  const { report, ...withoutReport } = doc.attribution.operations;
  assert.throws(
    () => loadSlo(null, { ...doc, attribution: { ...doc.attribution, operations: withoutReport } }),
    /endpoint "report" is classified but has no attribution\.operations entry/,
  );
});

test('queueing_ms_by_route subtracts the operations each route actually issues', () => {
  // The defect this replaces: one avg() over every operation on the table,
  // subtracted identically from all four routes. Measured live 2026-09-01 --
  // GetItem 0.912, PutItem 2.018, Query 1.1625, BatchWriteItem 0 (seeding, not
  // request traffic) -- that average was 1.01 ms where /reports needs
  // Query + PutItem = 2.79 ms. A ~1.8 ms error on a signal built to detect a few
  // ms of event-loop queueing.
  const doc = loadSlo(`${HERE}slo.yaml`);
  const expr = JSON.parse(renderQueries(doc)).queueing_ms_by_route;

  // The old shape must be gone: no table-wide average, and never a
  // SuccessfulRequestLatency selector without an operation.
  assert.doesNotMatch(expr, /avg\(aws_dynamodb_successful_request_latency_average/);
  for (const sel of expr.match(/aws_dynamodb_successful_request_latency_average\{[^}]*\}/g) ?? []) {
    assert.match(sel, /dimension_Operation="/, `a SuccessfulRequestLatency selector with no operation: ${sel}`);
  }

  // One term per classified route, each subtracting exactly its own operations,
  // in order -- so /reports gets Query + PutItem and /feeds/:pk gets Query alone.
  const classified = classifiedEndpoints(doc);
  const terms = expr.split('\n  or\n');
  assert.equal(terms.length, classified.length, 'one queueing term per classified route');
  for (const endpoint of classified) {
    const route = doc.endpoints[endpoint];
    const term = terms.find((t) => t.includes(`http_route="${route}"`));
    assert.ok(term, `no queueing term for ${route}`);
    const ops = [...term.matchAll(/dimension_Operation="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ops, doc.attribution.operations[endpoint],
      `${route} subtracts ${JSON.stringify(ops)} but slo.yaml says it issues ${JSON.stringify(doc.attribution.operations[endpoint])}`);
  }
});

test('changing attribution.operations changes the generated queueing query', () => {
  // The assertion that would have caught the shipped bug: if the generator stops
  // reading the map, this output stops moving when the map moves.
  const doc = loadSlo(`${HERE}slo.yaml`);
  const before = JSON.parse(renderQueries(doc)).queueing_ms_by_route;
  const mutated = loadSlo(null, {
    ...doc,
    attribution: { ...doc.attribution, operations: { ...doc.attribution.operations, report: ['Scan'] } },
  });
  const after = JSON.parse(renderQueries(mutated)).queueing_ms_by_route;

  assert.notEqual(after, before, 'attribution.operations is not being read by renderQueries');
  const reportTerm = after.split('\n  or\n').find((t) => t.includes('http_route="/reports"'));
  assert.match(reportTerm, /dimension_Operation="Scan"/);
  assert.doesNotMatch(reportTerm, /dimension_Operation="PutItem"/);
});

test('an absent latency class contributes zero rather than emptying the numerator', () => {
  // In PromQL a binary operation with an empty vector is empty, so a class with
  // no traffic in the window would empty the whole numerator while the
  // denominator stayed populated -- sli_ratio then returns NOTHING, and every
  // rule group carries no_data_state = "OK", so the alerts silently do not fire.
  // Verified live: with one class selector matching nothing, the pre-fix
  // expression returned an empty result set and the fixed one returned 0.75.
  const doc = loadSlo(`${HERE}slo.yaml`);
  const lines = ratioExpr(doc, { range: '5m' }).split('\n');
  const classes = Object.keys(doc.slos.find((s) => s.sli === 'class_threshold_ratio').classes);
  for (const name of classes) {
    const line = lines.find((l) => l.includes(`class="${name}"`));
    assert.ok(line, `no numerator term for class ${name}`);
    assert.ok(line.trimEnd().endsWith('or vector(0))'),
      `class ${name}'s term is not empty-safe -- an absent class would empty the numerator: ${line.trim()}`);
  }
  // And the derived files carry it, since they are the ones that actually alert.
  assert.equal((renderAlerts(doc).match(/or vector\(0\)\)/g) ?? []).length, classes.length * 4);
  assert.equal((renderLocals(doc).match(/or vector\(0\)\)/g) ?? []).length, classes.length);
});

test('the cpu saturation query divides by the real vCPU allocation', () => {
  const q = JSON.parse(renderQueries(loadSlo(`${HERE}slo.yaml`)));
  assert.match(q.cpu_saturation_ratio, /0\.25/);
});

test('slo.yaml vcpu_per_task agrees with terraform task_cpu, which is the thing that allocates it', () => {
  // vcpu_per_task is a COPY of a number Terraform owns: task_cpu is in CPU units
  // where 1024 = 1 vCPU. Nothing joined the two, so raising task_cpu to 512 would
  // leave cpu_saturation_ratio dividing by 0.25 and reporting a task at 50% as
  // pinned at 100% -- exactly the misattribution this dashboard exists to
  // prevent. Derive the expected value instead of pinning the literal.
  const doc = loadSlo(`${HERE}slo.yaml`);
  const tfvars = readFileSync(`${HERE}terraform/dev.tfvars`, 'utf8');
  const found = /^\s*task_cpu\s*=\s*(\d+)\s*$/m.exec(tfvars);
  assert.ok(found, 'terraform/dev.tfvars no longer sets task_cpu; the cross-check has nothing to compare against');
  const expected = Number(found[1]) / 1024;
  assert.equal(
    doc.attribution.vcpu_per_task, expected,
    `slo.yaml vcpu_per_task=${doc.attribution.vcpu_per_task} but dev.tfvars task_cpu=${found[1]} means ${expected} vCPU`,
  );
});

test('the SLO scope no longer excludes /stats, because /stats no longer exists', () => {
  const out = renderAlerts(loadSlo(`${HERE}slo.yaml`));
  assert.match(out, /http_route!~"\/healthz"/);
  assert.ok(!out.includes('/stats'), 'a deleted route is still named in a generated selector');
});

// Every http_server_* histogram this service emits is NATIVE: there is no
// "_sum" / "_count" / "_bucket" series to match. That form parses, returns
// "success", and matches nothing -- forever -- which is exactly the silent-empty
// failure this project exists to catch. The correct form is
// histogram_sum(rate(X{...}[range])) / histogram_count(rate(X{...}[range])) on
// the bare metric name.
//
// The previous pattern here required a trailing "{", so
// `rate(http_server_db_duration_seconds_sum[60s])` -- a range vector with no
// label matcher, the single most likely way to write this wrong -- slipped
// straight through, and http_server_request_duration_seconds was not covered at
// all. \w+ covers every instrument and \b matches the "[" of a range vector.
const CLASSIC_SERIES = /http_server_\w+_seconds_(sum|count|bucket)\b/;

test('the classic-series pattern actually discriminates the broken form from the fixed one', () => {
  // A guard whose regex cannot fail is worse than no guard, because it reads as
  // coverage. Pin both directions rather than trusting the pattern by eye.
  for (const broken of [
    'rate(http_server_db_duration_seconds_sum[60s])',
    'rate(http_server_request_duration_seconds_count[5m])',
    'rate(http_server_cpu_duration_seconds_sum{job="x"}[60s])',
    'histogram_quantile(0.99, rate(http_server_request_duration_seconds_bucket[5m]))',
  ]) {
    assert.ok(CLASSIC_SERIES.test(broken), `pattern missed a classic-series query: ${broken}`);
  }
  for (const fixed of [
    'histogram_sum(rate(http_server_db_duration_seconds{job="x"}[60s]))',
    'histogram_count(sum(rate(http_server_request_duration_seconds{job="x"}[5m])))',
  ]) {
    assert.ok(!CLASSIC_SERIES.test(fixed), `pattern rejected a correct native-histogram query: ${fixed}`);
  }
});

test('no query in queries.json addresses a service histogram by its classic _sum/_count series', () => {
  const q = JSON.parse(renderQueries(loadSlo(`${HERE}slo.yaml`)));
  for (const [key, expr] of Object.entries(q)) {
    assert.ok(
      !CLASSIC_SERIES.test(expr),
      `${key} addresses a native histogram by its classic _sum/_count/_bucket series: ${expr}`,
    );
  }
});

test('no generated Terraform addresses a service histogram by its classic _sum/_count series either', () => {
  // alerts.tf and locals.tf carry the same PromQL and were never covered.
  const doc = loadSlo(`${HERE}slo.yaml`);
  assert.ok(!CLASSIC_SERIES.test(renderAlerts(doc)), 'alerts.tf queries a classic _sum/_count series');
  assert.ok(!CLASSIC_SERIES.test(renderLocals(doc)), 'locals.tf queries a classic _sum/_count series');
});

test('alert rules query native histograms and carry the derived burn windows', () => {
  const out = renderAlerts(loadSlo(`${HERE}slo.yaml`));

  // The whole point of native histograms: thresholds applied at query time.
  assert.match(out, /histogram_fraction\(0, 0\.05,/);   // fast     50ms
  assert.match(out, /histogram_fraction\(0, 0\.2,/);    // standard 200ms
  assert.match(out, /histogram_fraction\(0, 0\.8,/);    // heavy    800ms

  // Derived from window: 7d, not copied from a 30-day reference.
  assert.match(out, /\[14m\]/);
  assert.match(out, /\[84m\]/);
  assert.doesNotMatch(out, /\[1h\]/);
  assert.doesNotMatch(out, /\[6h\]/);

  // The k6-era series must be gone entirely, not merely unused.
  assert.doesNotMatch(out, /slo_met/);
  assert.doesNotMatch(out, /http_req_failed/);

  // Scoped by job, which OTLP derives from service.name -- not by a --tag a run
  // can forget to pass.
  assert.match(out, /job="ecs-dynamodb-rps-ceiling"/);

  // Health checks outnumber real traffic between runs by 1.5x to 6x.
  assert.match(out, /http_route!~"\/healthz"/);
});

test('grafana/locals.tf is generated, so the SLO objective cannot drift from slo.yaml', () => {
  // grafana_slo's objective and window used to be typed into grafana/slo.tf by
  // hand -- the same numbers as slo.yaml, in a file slo:check never read. They
  // are generated now, so this is a byte-identity check like every other output.
  const doc = loadSlo(`${HERE}slo.yaml`);
  assert.equal(renderLocals(doc), readFileSync(`${HERE}grafana/locals.tf`, 'utf8'));
});

test('the generated locals carry slo.yaml\'s objective and window verbatim', () => {
  const doc = loadSlo(`${HERE}slo.yaml`);
  const out = renderLocals(doc);
  assert.match(out, /slo_objective = 0\.99\n/);
  assert.match(out, /slo_window    = "7d"\n/);
  // And slo.tf must READ them rather than restate them.
  const sloTf = readFileSync(`${HERE}grafana/slo.tf`, 'utf8');
  assert.match(sloTf, /value  = local\.slo_objective/);
  assert.match(sloTf, /window = local\.slo_window/);
  assert.doesNotMatch(sloTf, /value  = 0\.99/);
});

test('the SLO query is the same ratio the burn rules read', () => {
  // Same population, or grafana_slo and its own alerts measure different things.
  const doc = loadSlo(`${HERE}slo.yaml`);
  const body = ratioExpr(doc, { range: '$__rate_interval', job: '${var.project}' })
    .split('\n').map((line) => `    ${line}`).join('\n');
  assert.ok(
    readFileSync(`${HERE}grafana/locals.tf`, 'utf8').includes(`<<-PROMQL\n${body}\n  PROMQL`),
    'grafana/locals.tf no longer matches ratioExpr(doc, { range: "$__rate_interval" })',
  );
});

test('histogram_fraction is applied to an AGGREGATED histogram, never per series', () => {
  const out = renderLocals(loadSlo(`${HERE}slo.yaml`));
  // The broken form applies the fraction to a bare rate() and sums afterwards.
  // One empty series then contributes NaN and poisons the whole sum.
  //
  // NOTE: the plan's original regex here was `/histogram_fraction\([^)]*rate\(/`,
  // which matches BOTH the broken form (`histogram_fraction(0, B, rate(...`) and
  // the fixed form (`histogram_fraction(0, B, sum(rate(...`) -- `[^)]*` allows
  // '(' through unchanged, so `sum(` never breaks the match. The red step still
  // failed for the right reason (the generator hadn't been fixed yet), but the
  // assertion could never turn green afterwards. Anchored on the literal
  // argument boundary instead, so it actually discriminates the two forms.
  assert.ok(!/histogram_fraction\(0,\s*[\d.]+,\s*rate\(/.test(out.replace(/\s+/g, ' ')),
    'histogram_fraction is being applied to a per-series rate() -- it must wrap sum(rate(...))');
  // The correct form aggregates first.
  assert.match(out.replace(/\s+/g, ' '), /histogram_fraction\(0, [\d.]+, sum\(rate\(/);
  assert.match(out.replace(/\s+/g, ' '), /histogram_count\(sum\(rate\(/);
});