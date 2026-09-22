// test/generate-slo.test.js
// Forked from ecs-dynamodb-rps/service/test/generate-slo.test.js on 2026-09-20.
// A bug fixed here does not reach the sibling copy; fix both.
//
// Dropped with the renderers they cover: every case over attribution.operations,
// the queueing subtraction, the DynamoDB throttle queries, the "a shed 429
// counts as good" selector case (this project has NO admission control, so
// nothing ever sheds with a 429), and every byte-identity check against a
// committed generated output -- infra/grafana/ and infra/k6/ arrive in plan 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { matchRoute, ROUTE_CLASS } from '../src/handlers.js';
import { POOL_WAIT_DURATION } from '../src/otel.js';
import {
  burnWindows, loadSlo, validateSlo, renderCapacityAdvisory, plannedStates,
  renderClassMap, renderK6, renderAlerts, renderQueries,
} from '../scripts/generate-slo.js';
import { ratioExpr, renderLocals, classRatio, rate } from '../scripts/generate-slo.js';

const HERE = new URL('../../', import.meta.url).pathname;
const RAW = parse(readFileSync(`${HERE}slo.yaml`, 'utf8'));

/**
 * slo.yaml ships with every threshold_ms NULL on purpose -- plan 3 freezes them
 * from a calibration run against the real instance -- and validateSlo refuses
 * that document, so nothing here can load the committed file as it stands.
 *
 * These are NOT thresholds and must never be read as a preview of the
 * calibrated ones. They are three distinct positive numbers, so that any
 * assertion about a rendered bound is DERIVED from them rather than pinned to a
 * literal: when plan 3 writes the real values, every test below keeps meaning
 * what it means today.
 */
const PLACEHOLDER_MS = { fast: 1, standard: 2, heavy: 3 };

/** The committed slo.yaml, with placeholder thresholds so renderers can run. */
function committed() {
  const doc = structuredClone(RAW);
  for (const slo of doc.slos) {
    if (slo.sli !== 'class_threshold_ratio') continue;
    for (const [name, cls] of Object.entries(slo.classes)) cls.threshold_ms = PLACEHOLDER_MS[name];
  }
  return loadSlo(null, doc);
}

/** The in-memory fixture the four new cases below work on. */
const doc = () => ({
  service: 'ecs-rds-postgres-pool',
  endpoints: { getPost: '/posts/:id', createPost: '/posts', feed: '/feeds/:id/posts', report: '/reports' },
  slos: [{
    name: 'latency-classes', sli: 'class_threshold_ratio', objective: 95, tail_objective: 99,
    classes: {
      fast: { threshold_ms: null, endpoints: ['getPost', 'createPost'] },
      standard: { threshold_ms: null, endpoints: ['feed'] },
      heavy: { threshold_ms: null, endpoints: ['report'] },
    },
  }],
  capacity: { target_rps: null, pool: { baseline_size: 5, released_size: 25 } },
});

const withThresholds = () => {
  const d = doc();
  d.slos[0].classes.fast.threshold_ms = 50;
  d.slos[0].classes.standard.threshold_ms = 200;
  d.slos[0].classes.heavy.threshold_ms = 800;
  return d;
};

// ---------------------------------------------------------------------------
// The guard this task exists to install.
// ---------------------------------------------------------------------------

test('an unset threshold fails the check with a message naming the class', () => {
  assert.throws(() => validateSlo(doc()), /fast.*threshold_ms|threshold_ms.*fast/i);
});

test('once thresholds are set the document validates', () => {
  assert.doesNotThrow(() => validateSlo(withThresholds()));
});

test('every endpoint belongs to exactly one class', () => {
  const d = withThresholds();
  d.slos[0].classes.heavy.endpoints.push('feed');
  assert.throws(() => validateSlo(d), /feed/);
});

test('the committed slo.yaml is still red on its thresholds, which is the point', () => {
  // The state plan 3 turns green. If this ever passes without plan 3 having run,
  // someone has invented the numbers the k6 VU sizing is derived from.
  assert.throws(() => loadSlo(null, structuredClone(RAW)), /threshold_ms/);
});

test('the capacity advisory prints pool size and never contributes an exit code', () => {
  const out = renderCapacityAdvisory(doc(), { poolMax: 5, desiredCount: 1 });
  assert.match(out, /advisory/i);
  assert.match(out, /5/);
});

test('the advisory names the pool size, the task count, their product and max_connections', () => {
  // The number that can take a db.t4g.micro down is `pool max x tasks` against
  // its own max_connections, so all four have to be on screen together or the
  // reader is doing the multiplication from memory.
  const d = structuredClone(RAW);
  const pool = d.capacity.pool;

  // The one-state override: how plan 2 will price the real desired_count once
  // infra/main/dev.tfvars exists.
  const one = renderCapacityAdvisory(d, { poolMax: pool.released_size, desiredCount: 4 });
  assert.match(one, new RegExp(`${pool.released_size}\\b`));
  assert.match(one, /\b4\b/);
  assert.match(one, new RegExp(`\\b${pool.released_size * 4}\\b`));
  assert.match(one, new RegExp(`\\b${pool.max_connections_estimate}\\b`));

  // And the form the CLI prints: EVERY state the knob sequence visits. Printing
  // one cell was the defect. `pool 25 x 1 = 25, 22.3% of estimate` is true of
  // knob 1 and is the ROOMIEST of the three states, so it read as 4.5x of
  // headroom when the state the project drives toward -- knob 2, 25 x 4 = 100
  // of ~112 -- has about 12% left, which is where `FATAL: sorry, too many
  // clients already` becomes reachable.
  const est = pool.max_connections_estimate;
  const out = renderCapacityAdvisory(d);
  const lines = out.split('\n');
  const states = plannedStates(d);
  assert.equal(states.length, 3, 'the spec knob table visits baseline, knob 1 and knob 2');
  for (const s of states) {
    const line = lines.find((l) => l.trimStart().startsWith(`${s.label} `));
    assert.ok(line, `no advisory row for ${s.label}`);
    const total = s.poolMax * s.desiredCount;
    assert.match(line, new RegExp(`pool\\s+${s.poolMax} x ${s.desiredCount} tasks?\\b`));
    assert.match(line, new RegExp(`=\\s+${total}\\b`));
    assert.match(line, new RegExp(`${((total / est) * 100).toFixed(1)}% of estimate`));
  }
  assert.match(out, new RegExp(`max_connections_estimate\\s+${est}\\b`));

  // Exactly one row is marked, and it is the largest product -- not the first
  // row, not the one whose pool is biggest.
  const worst = states.reduce((a, b) => (a.poolMax * a.desiredCount > b.poolMax * b.desiredCount ? a : b));
  const marked = lines.filter((l) => l.includes('<--'));
  assert.equal(marked.length, 1, 'exactly one row carries the ceiling marker');
  assert.ok(marked[0].trimStart().startsWith(`${worst.label} `),
    `the marker is on ${marked[0].trim()}, not on the tightest state (${worst.label})`);

  // And the marker says WHY that row matters: a refused connection is a 5xx, so
  // it lands on the availability objective rather than the latency classes.
  // Derived from the document, so it tracks slo.yaml rather than restating it.
  const availability = d.slos.find((s) => s.sli === 'success_rate');
  assert.match(out, /too many clients already/);
  assert.match(out, /5xx/);
  assert.ok(out.includes(`${availability.objective}% availability`),
    `the warning does not name the availability objective (${availability.objective}%)`);
});

test('the advisory renders UNSET rather than NaN on a document with holes in it', () => {
  // It runs on the UNVALIDATED document, before validateSlo can refuse
  // anything, so it meets malformed input by construction -- and a block whose
  // whole job is to be read before an apply must not answer "NaN%".
  const empty = renderCapacityAdvisory({ service: 's' });
  assert.doesNotMatch(empty, /NaN/);
  assert.match(empty, /UNSET/);

  const noCounts = structuredClone(RAW);
  delete noCounts.capacity.pool.task_counts;
  const out = renderCapacityAdvisory(noCounts);
  assert.doesNotMatch(out, /NaN/);
  assert.match(out, /UNSET/);
  // The estimate it does have is still reported.
  assert.match(out, new RegExp(`${RAW.capacity.pool.max_connections_estimate}\\b`));
});

test('the planned states are the knob sequence the spec names, built only from slo.yaml', () => {
  // Spec section 6.2: baseline pool 5 x 1 = 5, knob 1 pool 25 x 1 = 25, knob 2
  // pool 25 x 4 = 100 against ~112. Derived from the document's own keys so a
  // change to baseline_size / released_size / task_counts moves the advisory.
  const pool = RAW.capacity.pool;
  assert.deepEqual(plannedStates(RAW), [
    { label: 'baseline', poolMax: pool.baseline_size, desiredCount: pool.task_counts[0] },
    { label: 'knob 1', poolMax: pool.released_size, desiredCount: pool.task_counts[0] },
    { label: 'knob 2', poolMax: pool.released_size, desiredCount: pool.task_counts[1] },
  ]);
  assert.deepEqual(plannedStates({}), []);
});

// ---------------------------------------------------------------------------
// The two mappings of route -> class, asserted against each other.
// ---------------------------------------------------------------------------

test('ROUTE_CLASS and slo.yaml agree on every route’s class', () => {
  // The mapping lives in two places -- src/handlers.js tags the metric with it,
  // slo.yaml defines the objective over it -- so it is asserted in both
  // directions. Built from the COMMITTED document rather than the fixture
  // above: a fixture would only prove the fixture and handlers.js agree, which
  // is a third copy of the same table.
  const fromYaml = {};
  for (const [cls, body] of Object.entries(classRatio(committed()).classes)) {
    for (const ep of body.endpoints) fromYaml[ep] = cls;
  }
  assert.deepEqual(ROUTE_CLASS, fromYaml);
});

test('slo.yaml names the pool-wait metric src/otel.js actually emits', () => {
  // The name lives in three places -- the instrument in src/otel.js, the
  // attribution block here, and the Grafana queries plan 2 will generate from
  // it -- and it has already drifted once, which cost a commit of its own.
  // Nothing generated reads attribution.pool_wait_metric yet, so this is the
  // only thing standing between a rename and a dashboard that matches nothing.
  assert.equal(RAW.attribution.pool_wait_metric, POOL_WAIT_DURATION,
    'slo.yaml attribution.pool_wait_metric must equal POOL_WAIT_DURATION in src/otel.js');
});

test('every endpoint in slo.yaml maps to a route template that handlers.js serves', () => {
  const model = committed();
  for (const [name, template] of Object.entries(model.endpoints)) {
    // Rebuild a concrete path from the template so matchRoute can be asked
    // whether this route still exists under that exact name.
    const concrete = template.replace(/:[^/]+/g, 'x');
    const method = template === '/posts' || template === '/reports' ? 'POST' : 'GET';
    const hit = matchRoute(method, concrete);
    assert.ok(hit, `slo.yaml names endpoint "${name}" at ${template}, which handlers.js does not serve`);
    assert.equal(hit.template, template);
    assert.equal(hit.name, name);
  }
});

test('every class member is a declared endpoint', () => {
  const model = committed();
  const slo = classRatio(model);
  for (const cls of Object.values(slo.classes)) {
    for (const endpoint of cls.endpoints) {
      assert.ok(model.endpoints[endpoint], `class references undeclared endpoint "${endpoint}"`);
    }
  }
});

test('the class map is keyed by route template, not endpoint name', () => {
  const map = JSON.parse(renderClassMap(committed()));
  assert.deepEqual(map, {
    '/posts/:id': 'fast',
    '/posts': 'fast',
    '/feeds/:id/posts': 'standard',
    '/reports': 'heavy',
  });
  // /healthz is absent on purpose: it is emitted but unclassified, and the SLO
  // query excludes it by selector.
  assert.equal(map['/healthz'], undefined);
});

// ---------------------------------------------------------------------------
// Validation, windows and objectives.
// ---------------------------------------------------------------------------

test('a mix that does not sum to 1.0 is refused', () => {
  assert.throws(
    () => loadSlo(null, { service: 's', window: '30d', slos: [], capacity: {
      target_rps: 1000, mix: { read: 0.5, write: 0.1 },
    } }),
    /mix must sum to 1\.0/,
  );
});

test('a capacity block with no mix is refused when the document came off disk', () => {
  // The sibling read doc.capacity.mix unconditionally and died with a TypeError
  // on a capacity block that had no mix. Guarding that with `?.` alone traded
  // the TypeError for silence: a slo.yaml that LOST its `mix:` block would then
  // validate clean, and capacity.mix is where the load profile's request
  // distribution comes from. A document read from disk must be complete.
  const dir = mkdtempSync(join(tmpdir(), 'slo-'));
  const file = join(dir, 'slo.yaml');
  try {
    writeFileSync(file, 'service: s\nwindow: 7d\nslos: []\ncapacity:\n  target_rps: null\n  pool: { baseline_size: 5 }\n');
    assert.throws(() => loadSlo(file), /capacity\.mix/);
    writeFileSync(file, 'service: s\nwindow: 7d\nslos: []\ncapacity:\n  target_rps: null\n  mix: { read: 1.0 }\n  pool: { baseline_size: 5 }\n');
    assert.doesNotThrow(() => loadSlo(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pre-parsed fixture may omit capacity.mix, and a caller can still demand it', () => {
  // The fixtures here carry a capacity with a pool and no mix, by design -- a
  // document handed over in memory is partial. The rule is available to any
  // caller that knows it is holding a document that ought to be whole.
  assert.doesNotThrow(() => validateSlo(withThresholds()));
  assert.throws(() => validateSlo(withThresholds(), { requireCapacityMix: true }), /capacity\.mix/);
});

test('an endpoint in two classes is refused through loadSlo too, not only validateSlo', () => {
  // Two entry points, one implementation. A rule that held on the in-memory
  // path and not on the file path would still read as checked from both.
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

test('the committed slo.yaml is a 7-day window with 14m/84m burn alerting', () => {
  // 7d is the intersection of two hard limits, not a preference. Grafana's SLO
  // API refuses anything outside 7-32 days ("Use time window of at least 7 days
  // and at most 32 days"), and Grafana Cloud Free retains metrics for 14 days,
  // so a longer window could never be evaluated over the period it claims.
  const model = committed();
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
  const model = committed();
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
  // renders green forever while the alert list still shows healthy rules.
  //
  // At 14.4x the floor is 93.06%, which is why the primary objective here is
  // 95% and not lower.
  const model = committed();
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
        `${name} at ${objective}% makes the ${kind}-burn rule unfirable: it needs a `
        + `${(threshold * 100).toFixed(1)}% miss rate. Floor for ${burn.multiplier}x is `
        + `${(100 - 100 / burn.multiplier).toFixed(2)}%.`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The SLI expression.
// ---------------------------------------------------------------------------

test('an absent latency class contributes zero rather than emptying the numerator', () => {
  // In PromQL a binary operation with an empty vector is empty, so a class with
  // no traffic in the window would empty the whole numerator while the
  // denominator stayed populated -- sli_ratio then returns NOTHING, and every
  // rule group carries no_data_state = "OK", so the alerts silently do not fire.
  const model = committed();
  const lines = ratioExpr(model, { range: '5m' }).split('\n');
  const classes = Object.keys(classRatio(model).classes);
  for (const name of classes) {
    const line = lines.find((l) => l.includes(`class="${name}"`));
    assert.ok(line, `no numerator term for class ${name}`);
    assert.ok(line.trimEnd().endsWith('or vector(0))'),
      `class ${name}'s term is not empty-safe -- an absent class would empty the numerator: ${line.trim()}`);
  }
  // And the derived files carry it, since they are the ones that actually alert:
  // one per class per latency rule (2 objectives x 2 speeds), plus one per
  // availability rule (2 speeds), whose numerator needs the same guard.
  assert.equal((renderAlerts(model).match(/or vector\(0\)\)/g) ?? []).length, classes.length * 4 + 2);
  assert.equal((renderLocals(model).match(/or vector\(0\)\)/g) ?? []).length, classes.length);
});

test('a fast 5xx is a miss: the numerator excludes server errors, the denominator keeps them', () => {
  // k6's slo_met requires a 2xx before it looks at the duration. Without the
  // same rule here a request that fails in 3 ms sits inside histogram_fraction
  // and is scored as meeting its class, and results.md records two different
  // indicators under one name. 4xx is deliberately not excluded (slo.yaml): this
  // project has no admission control, so no 4xx is ever a shed request.
  const model = committed();
  const expr = ratioExpr(model, { range: '5m' });
  const [numerator, denominator] = expr.split('\n  /\n');
  const classes = Object.keys(classRatio(model).classes);
  // Every class term filters, in BOTH of its selectors (fraction and count).
  assert.equal((numerator.match(/http_response_status_code!~"5\.\."/g) ?? []).length, classes.length * 2);
  assert.doesNotMatch(denominator, /http_response_status_code/);
  // The only thing ever excluded is 5xx. A 4xx is not charged to the service.
  for (const [, pattern] of expr.matchAll(/http_response_status_code!~"([^"]*)"/g)) {
    assert.equal(pattern, '5..', `numerator excludes ${pattern}; only 5xx may be excluded`);
  }
  // Label name as Grafana Cloud's OTLP translation emits it.
  assert.doesNotMatch(expr, /http\.response\.status_code/);
});

test('histogram_fraction is applied to an AGGREGATED histogram, never per series', () => {
  const out = renderLocals(committed());
  // The broken form applies the fraction to a bare rate() and sums afterwards.
  // One empty series then contributes NaN and poisons the whole sum.
  assert.ok(!/histogram_fraction\(0,\s*[\d.]+,\s*rate\(/.test(out.replace(/\s+/g, ' ')),
    'histogram_fraction is being applied to a per-series rate() -- it must wrap sum(rate(...))');
  // The correct form aggregates first.
  assert.match(out.replace(/\s+/g, ' '), /histogram_fraction\(0, [\d.]+, sum\(rate\(/);
  assert.match(out.replace(/\s+/g, ' '), /histogram_count\(sum\(rate\(/);
});

// ---------------------------------------------------------------------------
// The generated Grafana rules.
// ---------------------------------------------------------------------------

test('the availability objective gets its own burn rules, on the same population', () => {
  const out = renderAlerts(committed());
  assert.match(out, /resource "grafana_rule_group" "availability_fastburn"/);
  assert.match(out, /resource "grafana_rule_group" "availability_slowburn"/);
  // 99.9% -> sustainable miss 0.1%; 14.4x = 1.44%, 6x = 0.6%.
  assert.match(out, /params = \[0\.0144\]/);
  assert.match(out, /params = \[0\.006\]/);
  // Ratio of counts, native-histogram form, non-5xx over all.
  assert.match(out, /histogram_count\(sum\(rate\(http_server_request_duration_seconds\{[^}]*http_response_status_code!~"5\.\."\}\[14m\]\)\)\)/);
  assert.equal((out.match(/^resource "grafana_rule_group"/gm) ?? []).length, 6);
});

test('alert rules query native histograms and carry the derived burn windows', () => {
  const model = committed();
  const out = renderAlerts(model);
  const slo = classRatio(model);

  // The whole point of native histograms: thresholds applied at query time.
  // Derived from the document, not pinned -- these are placeholder milliseconds
  // today and calibrated ones after plan 3, and the property is the same.
  for (const [name, cls] of Object.entries(slo.classes)) {
    const bound = String(cls.threshold_ms / 1000);
    assert.ok(out.includes(`histogram_fraction(0, ${bound},`),
      `no primary bound for class ${name} at ${bound}s`);
    const tail = String((cls.threshold_ms * slo.tail_multiplier) / 1000);
    assert.ok(out.includes(`histogram_fraction(0, ${tail},`),
      `no tail bound for class ${name} at ${tail}s`);
  }

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
  assert.match(out, /job="ecs-rds-postgres-pool"/);

  // Health checks outnumber real traffic between runs by a wide margin.
  assert.match(out, /http_route!~"\/healthz"/);
});

test('every generated rule carries a runbook link and a dashboard deep link', () => {
  // An alert that says only "burning error budget" makes the person it woke go
  // and find the dashboard and the runbook themselves, at the hour when that is
  // hardest. Grafana renders __dashboardUid__ + __panelId__ as a "View panel"
  // link, so both must be present on every rule, not just most of them.
  const out = renderAlerts(committed());
  const rules = (out.match(/^\s{2}rule \{/gm) ?? []).length;
  assert.equal(rules, 6);
  // This project's own README, not the sibling's -- a forked constant pointing
  // at ecs-dynamodb-rps would send the reader to the wrong runbook and never
  // 404. The heading itself arrives with the README in plan 2.
  assert.equal(
    (out.match(/runbook_url\s+= "https:\/\/github\.com\/[^"]*\/ecs-rds-postgres-pool\/README\.md#[^"]+"/g) ?? []).length,
    rules,
  );
  assert.doesNotMatch(out, /ecs-dynamodb-rps/);
  // An HCL REFERENCE, not a string. A quoted uid would pin a dashboard that a
  // recreate replaces, and the link would 404 silently.
  assert.equal(
    (out.match(/__dashboardUid__ = grafana_dashboard\.attribution\.uid$/gm) ?? []).length,
    rules,
  );
  assert.doesNotMatch(out, /__dashboardUid__ = "/);
  // Every rule deep-links to a panel. The id is NOT pinned here: plan 2 writes
  // the dashboard and owns the number, and asserting a literal for a dashboard
  // that does not exist would assert a fiction.
  assert.equal((out.match(/__panelId__\s+= "\d+"/g) ?? []).length, rules);
});

test('every generated rule names its contact point instead of inheriting the root policy', () => {
  // The stack's root policy happens to route to Slack today. That default is
  // declared nowhere in this repo, so an edit for another project would
  // redirect these rules with no diff here. Each rule says where it goes.
  const out = renderAlerts(committed());
  const rules = (out.match(/^\s{2}rule \{/gm) ?? []).length;
  const routed = (out.match(/contact_point = var\.alert_contact_point/g) ?? []).length;
  assert.equal(rules, 6);
  assert.equal(routed, rules, 'a rule without notification_settings inherits the root policy');
  assert.match(out, /group_by\s+= \["alertname", "slo"\]/);
});

test('the generated locals carry slo.yaml\'s objective and window verbatim', () => {
  // Derived from slo.yaml, not pinned to a literal. Pinning 0.95 here would make
  // this test assert "the objective is 95%" rather than "locals restates
  // whatever slo.yaml says", and it would fail on the next relaxation even
  // though the property it names held perfectly.
  const model = committed();
  const out = renderLocals(model);
  const objective = classRatio(model).objective;
  assert.match(out, new RegExp(`slo_objective = ${rate(objective)}\n`));
  assert.match(out, new RegExp(`slo_window    = "${model.window}"\n`));
});

test('the SLO query is the same ratio the burn rules read', () => {
  // Same population, or grafana_slo and its own alerts measure different things.
  // The sibling asserts this against a committed grafana/locals.tf; that file
  // arrives in plan 2, so the property is asserted against the renderer instead
  // -- which is where it actually lives.
  const model = committed();
  const body = ratioExpr(model, { range: '$__rate_interval', job: '${var.project}' })
    .split('\n').map((line) => `    ${line}`).join('\n');
  assert.ok(
    renderLocals(model).includes(`<<-PROMQL\n${body}\n  PROMQL`),
    'renderLocals no longer embeds ratioExpr(doc, { range: "$__rate_interval" })',
  );
});

// ---------------------------------------------------------------------------
// The generated k6 thresholds.
// ---------------------------------------------------------------------------

test('k6 thresholds gate on dropped iterations and report per-class p99 without gating on it', () => {
  // An arrival-rate run that exhausts its VUs delivers less than RATE and
  // passes the SLO at that lower rate. count==0 refuses it.
  const out = renderK6(committed());
  assert.match(out, /dropped_iterations: \['count==0'\]/);
  // k6 has no non-gating threshold, and only prints a tagged sub-metric when a
  // threshold references it. p(99)>=0 is the one form that reports without gating.
  assert.match(out, /'http_req_duration\{class:fast\}': \['p\(99\)>=0'\]/);
  assert.doesNotMatch(out, /p\(99\)<\d/, 'a per-class p99 threshold that can fail makes p99 part of the verdict');
});

// ---------------------------------------------------------------------------
// Native histograms: there is no _sum / _count / _bucket series to match.
// ---------------------------------------------------------------------------

// Every http_server_* histogram this service emits is NATIVE. The classic form
// parses, returns "success", and matches nothing -- forever -- which is exactly
// the silent-empty failure this project exists to catch. The correct form is
// histogram_sum(rate(X{...}[range])) / histogram_count(rate(X{...}[range])) on
// the bare metric name. \w+ covers every instrument and \b matches the "[" of a
// range vector, so a bare `rate(X_sum[60s])` cannot slip through.
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

test('no generated Terraform addresses a service histogram by its classic _sum/_count series', () => {
  const model = committed();
  assert.ok(!CLASSIC_SERIES.test(renderAlerts(model)), 'alerts.tf queries a classic _sum/_count series');
  assert.ok(!CLASSIC_SERIES.test(renderLocals(model)), 'locals.tf queries a classic _sum/_count series');
});

// ---------------------------------------------------------------------------
// Plan 2: the two outputs that do not depend on a calibrated threshold.
// ---------------------------------------------------------------------------

test('the attribution queries are built on the pool wait metric, not on dynamodb operations', () => {
  const q = JSON.parse(renderQueries(doc()));
  const text = JSON.stringify(q);
  assert.match(text, new RegExp(POOL_WAIT_DURATION.replace(/\./g, '_')),
    'the pool wait histogram is what this project measures; its metric name must appear');
  assert.doesNotMatch(text, /dynamodb|SuccessfulRequestLatency|queueing_ms_by_route/i,
    'the sibling subtracted a server-side clock Postgres does not publish');
});

test('pool wait is queried per class, because a global histogram cannot say whose requests queued', () => {
  const q = JSON.parse(renderQueries(doc()));
  assert.match(q.pool_wait_p99_by_class ?? '', /by \(class\)/);
});

test('queries.json renders without thresholds, and omits the one key that needs them', () => {
  const q = JSON.parse(renderQueries(doc())); // doc() has every threshold_ms null
  assert.equal(q.sli_ratio, undefined,
    'sli_ratio bakes thresholds into PromQL; it must not appear until plan 3 freezes them');
});

test('queries.json gains sli_ratio once thresholds are set', () => {
  const d = doc();
  d.slos[0].classes.fast.threshold_ms = 1;
  d.slos[0].classes.standard.threshold_ms = 2;
  d.slos[0].classes.heavy.threshold_ms = 3;
  assert.ok(JSON.parse(renderQueries(d)).sli_ratio);
});

test('the class map covers every classified route and nothing else', () => {
  assert.deepEqual(JSON.parse(renderClassMap(doc())), {
    '/posts/:id': 'fast',
    '/posts': 'fast',
    '/feeds/:id/posts': 'standard',
    '/reports': 'heavy',
  });
});

test('validateSlo can skip the threshold guard without skipping any other rule', () => {
  const d = doc();
  assert.doesNotThrow(() => validateSlo(d, { requireThresholds: false }));
  d.slos[0].classes.heavy.endpoints.push('feed');
  assert.throws(() => validateSlo(d, { requireThresholds: false }), /feed/,
    'the endpoint-in-two-classes rule must still fire with the threshold guard off');
});
