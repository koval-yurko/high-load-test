import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchRoute } from '../src/handlers.js';
import { burnWindows, loadSlo, capacityModel, readCapacityTfvars, renderClassMap, renderK6, renderAlerts, renderQueries } from '../scripts/generate-slo.js';
import { ratioExpr, renderLocals, classRatio, rate } from '../scripts/generate-slo.js';

const HERE = new URL('../../', import.meta.url).pathname;

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
  assert.equal(renderK6(model), readFileSync(`${HERE}infra/k6/tests/lib/slo.js`, 'utf8'));
});

test('dev.tfvars sets both capacity variables, and its values are read back', () => {
  // Capacity is hand-set and advisory-checked, so the one thing that IS still a
  // hard failure is it going MISSING: the variables have no default in
  // variables.tf and nothing else supplies them since capacity.auto.tfvars was
  // deleted, so an unset value stops a plan dead (or prompts, interactively).
  const set = readCapacityTfvars(readFileSync(`${HERE}infra/main/dev.tfvars`, 'utf8'));
  assert.equal(typeof set.read, 'number');
  assert.equal(typeof set.write, 'number');

  // The model is reported, not enforced -- this asserts the arithmetic, not the
  // file. 1000 rps x (0.55*0.5 + 0.25*2.5 + 0.05*2.5) = 1025 RCU, x 0.200 = 200 WCU.
  const model = capacityModel(loadSlo(`${HERE}slo.yaml`));
  assert.deepEqual([model.read, model.write], [1025, 200]);
});

test('a commented-out capacity line is not read as the setting', () => {
  const set = readCapacityTfvars('# read_capacity  = 25\nwrite_capacity = 200\n');
  assert.equal(set.read, null);
  assert.equal(set.write, 200);
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

test('every objective is high enough for its burn rules to be able to fire', () => {
  // A burn threshold is multiplier x (1 - objective) compared against a MISS
  // RATE, which cannot exceed 1. Push an objective low enough and the threshold
  // goes over 100%: the rule stops being strict, it becomes unfirable, and it
  // renders green forever while the alert list still shows nine healthy rules.
  //
  // At 14.4x the floor is 93.06%. This is the whole reason the 2026-09-09
  // relaxation stopped at 95% instead of the 85% originally asked for -- at 85%
  // the latency-primary page threshold is a 216% miss rate.
  const model = loadSlo(`${HERE}slo.yaml`);
  const slo = classRatio(model);
  const objectives = [
    ['latency primary', slo.objective],
    ['latency tail', slo.tail_objective],
    ...model.slos.filter((s) => s.sli === 'success_rate').map((s) => [s.name, s.objective]),
  ];
  for (const [name, objective] of objectives) {
    for (const [kind, burn] of Object.entries(model.burn)) {
      const threshold = burn.multiplier * ((100 - objective) / 100);
      assert.ok(
        threshold < 1,
        `${name} at ${objective}% makes the ${kind}-burn rule unfirable: it needs a ` +
        `${(threshold * 100).toFixed(1)}% miss rate. Floor for ${burn.multiplier}x is ` +
        `${(100 - 100 / burn.multiplier).toFixed(2)}%.`,
      );
    }
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

// Throttles are read live from CloudWatch now -- the dashboard's throttle panel, the
// throttle rule in grafana/throttles.tf and /loadtest all query the datasource directly,
// and Alloy no longer forwards a Prometheus copy (Tier 1.8 trimmed its DynamoDB block to
// SuccessfulRequestLatency alone). A generated PromQL throttle query would therefore
// render EMPTY: the series does not exist. This is the assertion that catches one being
// added back without the metric{} block that would feed it.
test('queries.json generates no PromQL over forwarded throttle series', () => {
  const q = JSON.parse(renderQueries(loadSlo(`${HERE}slo.yaml`)));
  for (const [key, expr] of Object.entries(q)) {
    assert.ok(!expr.includes('throttle_events'),
      `${key} reads a forwarded throttle series that Alloy no longer collects`);
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
  // And the derived files carry it, since they are the ones that actually alert:
  // one per class per latency rule (2 objectives x 2 speeds), plus one per
  // availability rule (2 speeds), whose numerator needs the same guard.
  assert.equal((renderAlerts(doc).match(/or vector\(0\)\)/g) ?? []).length, classes.length * 4 + 2);
  assert.equal((renderLocals(doc).match(/or vector\(0\)\)/g) ?? []).length, classes.length);
});

test('a fast 5xx is a miss: the numerator excludes server errors, the denominator keeps them', () => {
  // k6's slo_met requires a 2xx before it looks at the duration. Without the
  // same rule here a request that fails in 3 ms sits inside histogram_fraction
  // and is scored as meeting its class, and results.md records two different
  // indicators under one name. 4xx is deliberately not excluded (slo.yaml).
  const doc = loadSlo(`${HERE}slo.yaml`);
  const expr = ratioExpr(doc, { range: '5m' });
  const [numerator, denominator] = expr.split('\n  /\n');
  const classes = Object.keys(doc.slos.find((s) => s.sli === 'class_threshold_ratio').classes);
  // Every class term filters, in BOTH of its selectors (fraction and count).
  assert.equal((numerator.match(/http_response_status_code!~"5\.\."/g) ?? []).length, classes.length * 2);
  assert.doesNotMatch(denominator, /http_response_status_code/);
  // The only thing ever excluded is 5xx. A 4xx is not charged to the service.
  for (const [, pattern] of expr.matchAll(/http_response_status_code!~"([^"]*)"/g)) {
    assert.equal(pattern, '5..', `numerator excludes ${pattern}; only 5xx may be excluded`);
  }
  // Label name as Grafana Cloud's OTLP translation emits it, verified live 2026-09-02.
  assert.doesNotMatch(expr, /http\.response\.status_code/);
});

test('a shed 429 counts as good in every generated status filter', () => {
  // Admission control answers overload with 429 + Retry-After by design. On
  // the Grafana side that must not burn budget, though the k6 side counts it
  // as a miss -- a knowingly accepted divergence (see slo.yaml).
  // PromQL regex matchers are fully anchored, hence ^(?:...)$.
  const doc = loadSlo(`${HERE}slo.yaml`);
  const exprs = [ratioExpr(doc, { range: '5m' }), renderAlerts(doc), renderLocals(doc)].join('\n');
  const patterns = [...exprs.matchAll(/http_response_status_code!~"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(patterns.length > 0, 'no status filter found -- the parse is stale, not the rule');
  for (const p of patterns) {
    const excluded = new RegExp(`^(?:${p})$`);
    assert.equal(excluded.test('429'), false, `filter !~"${p}" would score a shed 429 as a miss`);
    assert.equal(excluded.test('503'), true, `filter !~"${p}" no longer excludes a 5xx`);
  }
});

test('the availability objective gets its own burn rules, on the same population', () => {
  const doc = loadSlo(`${HERE}slo.yaml`);
  const out = renderAlerts(doc);
  assert.match(out, /resource "grafana_rule_group" "availability_fastburn"/);
  assert.match(out, /resource "grafana_rule_group" "availability_slowburn"/);
  // 99.9% -> sustainable miss 0.1%; 14.4x = 1.44%, 6x = 0.6%.
  assert.match(out, /params = \[0\.0144\]/);
  assert.match(out, /params = \[0\.006\]/);
  // Ratio of counts, native-histogram form, non-5xx over all.
  assert.match(out, /histogram_count\(sum\(rate\(http_server_request_duration_seconds\{[^}]*http_response_status_code!~"5\.\."\}\[14m\]\)\)\)/);
  assert.equal((out.match(/^resource "grafana_rule_group"/gm) ?? []).length, 6);
});

test('every generated rule carries a runbook link and a dashboard deep link', () => {
  // An alert that says only "burning error budget" makes the person it woke go
  // and find the dashboard and the runbook themselves, at the hour when that is
  // hardest. Grafana renders __dashboardUid__ + __panelId__ as a "View panel"
  // link, so both must be present on every rule, not just most of them.
  const out = renderAlerts(loadSlo(`${HERE}slo.yaml`));
  const rules = (out.match(/^\s{2}rule \{/gm) ?? []).length;
  assert.equal(rules, 6);
  assert.equal(
    (out.match(/runbook_url\s+= "https:\/\/github\.com\/[^"]*#6-is-it-about-to-break"/g) ?? []).length,
    rules,
  );
  // An HCL REFERENCE, not a string. A quoted uid would pin a dashboard that a
  // recreate replaces, and the link would 404 silently.
  assert.equal(
    (out.match(/__dashboardUid__ = grafana_dashboard\.attribution\.uid$/gm) ?? []).length,
    rules,
  );
  assert.doesNotMatch(out, /__dashboardUid__ = "/);
  // Panel 19 is "SLI ratio: proportion meeting per-class threshold" -- the series
  // these rules alert on, not a neighbouring panel.
  assert.equal((out.match(/__panelId__\s+= "19"/g) ?? []).length, rules);
});

test('every generated rule names its contact point instead of inheriting the root policy', () => {
  // The stack's root policy happens to route to Slack today. That default is
  // declared nowhere in this repo, so an edit for another project would
  // redirect these rules with no diff here. Each rule says where it goes.
  const out = renderAlerts(loadSlo(`${HERE}slo.yaml`));
  const rules = (out.match(/^\s{2}rule \{/gm) ?? []).length;
  const routed = (out.match(/contact_point = var\.alert_contact_point/g) ?? []).length;
  assert.equal(rules, 6);
  assert.equal(routed, rules, 'a rule without notification_settings inherits the root policy');
  assert.match(out, /group_by\s+= \["alertname", "slo"\]/);
});

test('k6 thresholds gate on dropped iterations and report per-class p99 without gating on it', () => {
  // An arrival-rate run that exhausts its VUs delivers less than RATE and
  // passes the SLO at that lower rate. count==0 refuses it.
  const out = renderK6(loadSlo(`${HERE}slo.yaml`));
  assert.match(out, /dropped_iterations: \['count==0'\]/);
  // k6 has no non-gating threshold, and only prints a tagged sub-metric when a
  // threshold references it. p(99)>=0 is the one form that reports without gating.
  assert.match(out, /'http_req_duration\{class:fast\}': \['p\(99\)>=0'\]/);
  assert.doesNotMatch(out, /p\(99\)<\d/, 'a per-class p99 threshold that can fail makes p99 part of the verdict');
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
  const tfvars = readFileSync(`${HERE}infra/main/dev.tfvars`, 'utf8');
  const found = /^\s*task_cpu\s*=\s*(\d+)\s*$/m.exec(tfvars);
  assert.ok(found, 'infra/main/dev.tfvars no longer sets task_cpu; the cross-check has nothing to compare against');
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
  assert.match(out, /job="ecs-dynamodb-rps"/);

  // Health checks outnumber real traffic between runs by 1.5x to 6x.
  assert.match(out, /http_route!~"\/healthz"/);
});

test('grafana/locals.tf is generated, so the SLO objective cannot drift from slo.yaml', () => {
  // grafana_slo's objective and window used to be typed into grafana/slo.tf by
  // hand -- the same numbers as slo.yaml, in a file slo:check never read. They
  // are generated now, so this is a byte-identity check like every other output.
  const doc = loadSlo(`${HERE}slo.yaml`);
  assert.equal(renderLocals(doc), readFileSync(`${HERE}infra/grafana/locals.tf`, 'utf8'));
});

test('the generated locals carry slo.yaml\'s objective and window verbatim', () => {
  // Derived from slo.yaml, not pinned to a literal. Pinning 0.99 here made this
  // test assert "the objective is 99%" rather than "locals restates whatever
  // slo.yaml says" -- so it failed on the 2026-09-09 relaxation to 95% even
  // though the property it names held perfectly.
  const doc = loadSlo(`${HERE}slo.yaml`);
  const out = renderLocals(doc);
  const objective = classRatio(doc).objective;
  assert.match(out, new RegExp(`slo_objective = ${rate(objective)}\n`));
  assert.match(out, new RegExp(`slo_window    = "${doc.window}"\n`));
  // And slo.tf must READ them rather than restate them.
  const sloTf = readFileSync(`${HERE}infra/grafana/slo.tf`, 'utf8');
  assert.match(sloTf, /value  = local\.slo_objective/);
  assert.match(sloTf, /window = local\.slo_window/);
  assert.doesNotMatch(sloTf, /value  = 0\.\d+/);
});

test('the SLO query is the same ratio the burn rules read', () => {
  // Same population, or grafana_slo and its own alerts measure different things.
  const doc = loadSlo(`${HERE}slo.yaml`);
  const body = ratioExpr(doc, { range: '$__rate_interval', job: '${var.project}' })
    .split('\n').map((line) => `    ${line}`).join('\n');
  assert.ok(
    readFileSync(`${HERE}infra/grafana/locals.tf`, 'utf8').includes(`<<-PROMQL\n${body}\n  PROMQL`),
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