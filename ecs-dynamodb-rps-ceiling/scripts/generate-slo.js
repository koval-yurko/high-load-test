// scripts/generate-slo.js
// The single source: slo.yaml -> k6 thresholds, capacity tfvars, Grafana alert
// rules, Alloy class map. Nothing downstream of this file is edited by hand.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

const UNIT_SECONDS = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };

/** Prometheus duration -> seconds. The provider validates ^\d+(ms|s|m|h|d|w|y)$. */
export function durationSeconds(text) {
  const m = /^(\d+)(ms|s|m|h|d|w|y)$/.exec(text);
  if (!m) throw new Error(`window must match ^\\d+(ms|s|m|h|d|w|y)$, got ${JSON.stringify(text)}`);
  return Number(m[1]) * UNIT_SECONDS[m[2]];
}

/** Seconds -> the largest whole unit that divides it, for legible alert windows. */
export function formatDuration(seconds) {
  for (const [unit, size] of [['h', 3600], ['m', 60], ['s', 1]]) {
    if (seconds % size === 0) return `${seconds / size}${unit}`;
  }
  return `${seconds}s`;
}

/**
 * Percent -> the 0..1 rate k6 wants, with binary-float noise removed.
 * `99.9 / 100` is 0.9990000000000001 and `(100 - 99.9) / 100` is
 * 0.0009999999999999432. Emitting either verbatim would put a 16-digit
 * artefact in a generated threshold, so round at a precision far finer than
 * any objective anyone writes and print the shortest exact form.
 */
export const rate = (percent) => String(Number((percent / 100).toFixed(9)));

/**
 * Burn-rate alerting, derived rather than copied. The familiar 14.4x/1h and
 * 6x/6h are not conventions: they are what "2% of budget" and "5% of budget"
 * work out to on a 30-day window. Hold the multipliers and the budget
 * fractions fixed, and the ALERT WINDOWS must scale with the SLO window --
 * otherwise the same rules silently mean 20% and 50% on a 3-day window.
 */
export function burnWindows(windowSeconds) {
  const scale = windowSeconds / (30 * 86400);
  return {
    fast: { multiplier: 14.4, window: formatDuration(3600 * scale), forDuration: formatDuration(300 * scale), budgetFraction: 0.02, severity: 'page' },
    slow: { multiplier: 6, window: formatDuration(21600 * scale), forDuration: formatDuration(1800 * scale), budgetFraction: 0.05, severity: 'ticket' },
  };
}

export function loadSlo(path, preParsed) {
  const doc = preParsed ?? parse(readFileSync(path, 'utf8'));

  if (doc.capacity) {
    const shares = Object.values(doc.capacity.mix);
    const total = shares.reduce((a, b) => a + b, 0);
    // A mix that does not sum to one produces capacity numbers that are quietly
    // wrong rather than obviously wrong. Refuse, do not round.
    if (Math.abs(total - 1) > 1e-9) throw new Error(`capacity.mix must sum to 1.0, got ${total}`);
  }

  for (const slo of doc.slos ?? []) {
    if (slo.sli !== 'class_threshold_ratio') continue;
    const seen = new Set();
    for (const [name, cls] of Object.entries(slo.classes)) {
      for (const endpoint of cls.endpoints) {
        // An endpoint in no class is silently unmeasured; in two classes it is
        // measured against contradictory thresholds. Both are worse than a
        // wrong threshold, because neither is visible.
        if (seen.has(endpoint)) throw new Error(`endpoint "${endpoint}" appears in more than one class (${name})`);
        seen.add(endpoint);
      }
    }
  }

  // A class may only name endpoints the endpoints: block declares. Without this
  // the class map would silently drop the member, and its traffic would leave
  // the SLO population unclassified rather than failing loudly here.
  for (const slo of doc.slos ?? []) {
    if (slo.sli !== 'class_threshold_ratio') continue;
    for (const [name, cls] of Object.entries(slo.classes)) {
      for (const endpoint of cls.endpoints) {
        if (!doc.endpoints?.[endpoint]) throw new Error(`class "${name}" references undeclared endpoint "${endpoint}"`);
      }
    }
  }

  // A classified endpoint with no attribution.operations entry cannot have a
  // queueing query built for it, and the previous shape of that query -- one
  // avg() over the whole table -- hid exactly that: it rendered fine for a route
  // whose operations nobody had declared. Refuse here so the omission is a build
  // failure rather than a subtraction of the wrong number.
  if (doc.attribution) {
    for (const slo of doc.slos ?? []) {
      if (slo.sli !== 'class_threshold_ratio') continue;
      for (const cls of Object.values(slo.classes)) {
        for (const endpoint of cls.endpoints) {
          const ops = doc.attribution.operations?.[endpoint];
          if (!Array.isArray(ops) || ops.length === 0) {
            throw new Error(`endpoint "${endpoint}" is classified but has no attribution.operations entry`);
          }
        }
      }
    }
  }

  return { ...doc, windowSeconds: durationSeconds(doc.window), burn: burnWindows(durationSeconds(doc.window)) };
}

export const classRatio = (doc) => doc.slos.find((s) => s.sli === 'class_threshold_ratio');

export function renderK6(doc) {
  const slo = classRatio(doc);
  const map = Object.entries(slo.classes).map(([n, c]) => `${n}: ${c.threshold_ms}`).join(', ');
  const availability = doc.slos.find((s) => s.sli === 'success_rate');
  return `// GENERATED from slo.yaml by /slo. Do not edit by hand.
export const CLASS_THRESHOLD_MS = { ${map} };
export const TAIL_MULTIPLIER = ${slo.tail_multiplier};

export const thresholds = {
  // PRIMARY gate: >=${slo.objective.toFixed(1)}% of requests meet their own class threshold.
  slo_met: ['rate>${rate(slo.objective)}'],
  // TAIL: >=${slo.tail_objective.toFixed(1)}% meet ${slo.tail_multiplier}x their class threshold.
  slo_met_tail: ['rate>${rate(slo.tail_objective)}'],
  // Availability ${availability.objective}%. k6's rate metric counts FAILURES, so the objective inverts:
  // ${availability.objective}% success  ->  failure rate < ${rate(100 - availability.objective)}.
  http_req_failed: ['rate<${rate(100 - availability.objective)}'],
  // Secondary, per class. Diagnostic only — these are NOT the gate.
${Object.entries(slo.classes).map(([n, c]) => `  'http_req_duration{class:${n}}': ['p(99)<${c.threshold_ms}'],`).join('\n')}
};
`;
}

export function renderCapacityTfvars(doc) {
  const { mix, cost_per_request: cost, target_rps: rps } = doc.capacity;
  const per = (unit) => Object.entries(mix).reduce((sum, [k, share]) => sum + share * (cost[k][unit] ?? 0), 0);
  const rcu = per('rcu'), wcu = per('wcu');
  const terms = (unit) => Object.entries(mix)
    .filter(([k]) => (cost[k][unit] ?? 0) > 0)
    .map(([k, share]) => `${share}*${cost[k][unit].toFixed(1)}`).join(' + ');
  const rcuTerms = terms('rcu'), wcuTerms = terms('wcu');
  // The committed capacity.auto.tfvars pads the shorter (WCU) sum so the two
  // comment lines read as a column. Its padding runs one character past the
  // longer line, and that file is the hand-checked fixed point this generator
  // has to reproduce byte for byte -- so the offset is encoded here rather
  // than "corrected", which would rewrite a reviewed file for cosmetics.
  const column = Math.max(rcuTerms.length, wcuTerms.length);
  return `# GENERATED from slo.yaml by /slo. Do not edit by hand.
# ${rcuTerms.padEnd(column)} = ${rcu.toFixed(3)} RCU per rps
# ${wcuTerms.padEnd(column + 1)} = ${wcu.toFixed(3)} WCU per rps
read_capacity  = ${Math.round(rcu * rps)}
write_capacity = ${Math.round(wcu * rps)}
`;
}

/**
 * { "<route template>": "<class>" } -- what the collector's OTTL keys on.
 * Keyed by TEMPLATE, not endpoint name: slo.yaml is the human vocabulary,
 * http.route is the collector's, and this file is the join between them.
 * Unclassified routes (/healthz, and anything unmatched) are absent on purpose
 * -- the SLO query excludes them by selector. /stats used to be named here too;
 * that route no longer exists.
 */
export function renderClassMap(doc) {
  const slo = classRatio(doc);
  const map = {};
  for (const [name, cls] of Object.entries(slo.classes)) {
    for (const endpoint of cls.endpoints) map[doc.endpoints[endpoint]] = name;
  }
  return `${JSON.stringify(map, null, 2)}\n`;
}

const METRIC = 'http_server_request_duration_seconds';
/**
 * The SLO population: requests that belong to a latency class, and nothing else.
 *
 * The class selector is load-bearing, not decorative. The ALB is internet-facing,
 * so scanners probe it constantly -- measured at 0.12 req/s of 404s on unmatched
 * paths, which was 68% of the window. Those requests pass an http_route filter,
 * carry no class, and so land in the denominator while contributing nothing to
 * the numerator: every one of them counts as an SLO violation. It drove the
 * measured miss rate to 66% and put three burn rules into firing on background
 * noise.
 *
 * Selecting on class inverts the default. An endpoint is measured only once
 * slo.yaml gives it a class, so anything new -- a scanner path, an unclassified
 * route added later -- is silently EXCLUDED rather than silently counted as
 * failing. The http_route exclusion stays because it documents intent for the
 * one health endpoint, though the class selector already subsumes it.
 */
const CLASSES = (doc) => Object.keys(classRatio(doc).classes).join('|');
const SCOPE = (doc) => `job="${doc.service}", http_route!~"/healthz", class=~"${CLASSES(doc)}"`;

/** Proportion of requests meeting their own class threshold, over `range`. */
export function ratioExpr(doc, { multiplier = 1, range, job }) {
  const slo = classRatio(doc);
  const base = job ? SCOPE(doc).replace(`job="${doc.service}"`, `job="${job}"`) : SCOPE(doc);
  const good = Object.entries(slo.classes).map(([name, c]) => {
    const bound = ((c.threshold_ms * multiplier) / 1000);
    const sel = `${METRIC}{${base}, class="${name}"}`;
    // Aggregate BEFORE taking the fraction. Applying histogram_fraction per
    // series and summing afterwards yields NaN whenever any one series has zero
    // observations in the window -- which happens on every deploy (the retired
    // task lingers in range) and continuously once the service runs more than
    // one task. Native histograms sum exactly, so one fraction over the summed
    // histogram is both correct and NaN-safe.
    //
    // `or vector(0)` is the second half of the same defect. A class with NO
    // series at all in the window -- no traffic to any of its endpoints --
    // makes its term an EMPTY vector, and in PromQL `empty + anything` is
    // empty, so one silent class empties the entire numerator while the
    // denominator stays populated. The ratio then returns nothing, and every
    // rule group here carries no_data_state = "OK": the alerts silently do not
    // fire. That is currently masked only because the heartbeat touches all
    // four routes every minute. `vector(0)` carries no labels, exactly like
    // histogram_count(sum(...)), so the `+` still matches on the empty label
    // set and an absent class contributes 0 good requests instead of erasing
    // the measurement.
    const term = `histogram_fraction(0, ${bound}, sum(rate(${sel}[${range}]))) * histogram_count(sum(rate(${sel}[${range}])))`;
    return `    (${term} or vector(0))`;
  }).join('\n  +\n');
  return `(\n${good}\n  )\n  /\n  histogram_count(sum(rate(${METRIC}{${base}}[${range}])))`;
}

/**
 * grafana/locals.tf: the SLO object's own inputs, generated so they cannot drift
 * from slo.yaml.
 *
 * The objective and window were previously typed into grafana/slo.tf by hand --
 * the same 99.0 and 3d that live in slo.yaml, in a file `slo:check` did not read.
 * That is precisely the failure this generator exists to prevent: the SLO
 * asserting one number while the gate asserts another, both green, neither
 * meaning anything.
 *
 * The query is the same ratio the burn rules read, with two deliberate
 * differences: $__rate_interval in place of a literal range, and var.project in
 * place of the literal job name.
 *
 * The interval is NOT a style choice. grafana_slo rejects a hardcoded range
 * outright -- 400 "Query failed validation: missing one of [$__rate_interval,
 * $__range, $__interval]" -- because the SLO app re-evaluates the same query
 * over several windows and substitutes the interval itself. The burn rules in
 * alerts.tf keep their explicit 14m/84m ranges: those are ordinary alert
 * queries, evaluated by Grafana alerting, where nothing substitutes anything.
 */
export function renderLocals(doc) {
  const slo = classRatio(doc);
  const body = ratioExpr(doc, { range: '$__rate_interval', job: '${var.project}' })
    .split('\n').map((line) => `    ${line}`).join('\n');
  return `# GENERATED from slo.yaml by /slo. Do not edit by hand.
#
# The SLO object's inputs. objective and window come from slo.yaml so grafana_slo
# and the burn rules in alerts.tf cannot state different numbers, and the query is
# the same ratio those rules read -- differing only in $__rate_interval, which
# grafana_slo REQUIRES (it rejects a hardcoded range), and var.project for the
# job name.
locals {
  # ${slo.objective}% of requests meet their own class threshold, over ${doc.window}.
  slo_objective = ${rate(slo.objective)}
  slo_window    = "${doc.window}"

  class_ratio_query = <<-PROMQL
${body}
  PROMQL
}
`;
}

/** Burn alerting reads the MISS rate, so the ratio inverts. */
const missExpr = (doc, opts) => `1 - (\n  ${ratioExpr(doc, opts)}\n)`;

export function renderAlerts(doc) {
  const slo = classRatio(doc);
  const blocks = [];
  for (const [kind, burn] of Object.entries(doc.burn)) {
    for (const [label, objective, multiplier] of [
      ['primary', slo.objective, 1],
      ['tail', slo.tail_objective, slo.tail_multiplier],
    ]) {
      const sustainable = (100 - objective) / 100;
      const threshold = Number((burn.multiplier * sustainable).toFixed(6));
      blocks.push(`resource "grafana_rule_group" "latency_classes_${label}_${kind}burn" {
  name             = "${doc.service} / latency-classes ${label} / ${kind} burn"
  folder_uid       = grafana_folder.project.uid
  interval_seconds = 60

  rule {
    name      = "latency-classes ${label} burn rate >= ${burn.multiplier}x over ${burn.window}"
    condition = "C"
    for       = "${burn.forDuration}"

    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      query_type     = "instant"
      relative_time_range {
        from = ${durationSeconds(burn.window)}
        to   = 0
      }
      model = jsonencode({
        // refId is echoed back inside the model by Grafana's API. Omitting it
        // makes every subsequent plan propose removing it -- a perpetual diff
        // that trains a reviewer to skim the one place they must not skim.
        refId = "A"
        // instant, not range. query_type on the data block is NOT this flag: the
        // Prometheus datasource reads these booleans from the model, and without
        // them the rule evaluates over a range and returns a series, which the
        // threshold cannot reduce -- "looks like time series data, only reduced
        // data can be alerted on". Burn rate is already a rate over the window,
        // so one sample at evaluation time is the whole answer.
        instant = true
        range   = false
        expr    = <<-PROMQL
          ${missExpr(doc, { multiplier, range: burn.window }).split('\n').join('\n          ')}
        PROMQL
      })
    }

    // A -> B -> C, not A -> C. Grafana's expression pipeline will not apply a
    // threshold straight to a query: even an instant query arrives as a series,
    // and the rule fails with "looks like time series data, only reduced data
    // can be alerted on". The reducer is 'last' because A is already an instant
    // query -- there is exactly one sample to take.
    data {
      ref_id         = "B"
      datasource_uid = "__expr__"
      query_type     = "reduce"
      relative_time_range {
        from = ${durationSeconds(burn.window)}
        to   = 0
      }
      model = jsonencode({
        refId      = "B"
        type       = "reduce"
        reducer    = "last"
        expression = "A"
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      query_type     = "threshold"
      relative_time_range {
        from = ${durationSeconds(burn.window)}
        to   = 0
      }
      model = jsonencode({
        refId      = "C"
        type       = "threshold"
        expression = "B"
        conditions = [{ evaluator = { type = "gt", params = [${threshold}] } }]
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"

    annotations = {
      summary     = "latency-classes ${label} (${objective}% objective) burning error budget ~${burn.multiplier}x sustainable over ${burn.window}."
      computation = "window ${doc.window}; sustainable miss rate = 1 - ${objective / 100} = ${(sustainable * 100).toFixed(3)}%; ${kind}-burn threshold = ${burn.multiplier} * ${(sustainable * 100).toFixed(3)}% = ${(threshold * 100).toFixed(3)}%; alert window ${burn.window} = ${burn.budgetFraction * 100}% of budget"
    }
    labels = {
      severity = "${burn.severity}"
      slo      = "latency-classes-${label}"
    }
  }
}`);
    }
  }
  return `# GENERATED from slo.yaml by /slo. Do not edit by hand.
#
# Burn-rate alerting on error budget, not the raw SLI. Both the multipliers and
# the ALERT WINDOWS are derived from slo.yaml's window (${doc.window}): the
# familiar 14.4x/1h and 6x/6h encode "2% and 5% of budget" on a 30-day window,
# and against ${doc.window} the windows must scale or the same rules silently
# mean something else. Each rule's \`computation\` annotation shows its own
# arithmetic.
#
# The SLI is emitted by the service continuously -- these rules no longer depend
# on a k6 run having happened, which was the unresolved precondition the previous
# version of this file documented at its top.

${blocks.join('\n\n')}
`;
}

const DB = 'http_server_db_duration_seconds';
const CPU = 'http_server_cpu_duration_seconds';

/**
 * grafana/queries.json: every query the dashboard panels, /loadtest and the
 * README deep-links read, defined once.
 *
 * Four properties are load-bearing and each produces a silently wrong number
 * if dropped:
 *  - The service's own histograms are NATIVE histograms, not classic ones --
 *    there is no `_sum{...}` / `_count{...}` / `_bucket{...}` series to query.
 *    `rate(X_sum{...}[60s])` parses, returns "success", and matches nothing,
 *    forever -- the exact silent-empty failure this project exists to catch.
 *    The sum and count live inside the single native series and come out
 *    through `histogram_sum(rate(X{...}[60s]))` / `histogram_count(...)`, the
 *    same functions ratioExpr already uses via histogram_fraction/
 *    histogram_count. `sum by (...)` wraps the histogram_* call, not the
 *    other way around, or the label being grouped on is gone before the
 *    aggregation ever sees it.
 *  - CloudWatch SuccessfulRequestLatency is MILLISECONDS; the histograms are
 *    SECONDS. queueing_ms_by_route converts explicitly.
 *  - CloudWatch's throttled-requests series is a per-60s-period SUM exposed as
 *    a gauge, not a monotonic counter -- it goes 0 -> 500 -> 300 -> 0 as
 *    throttling starts and stops. `rate()` on it treats every decrease as a
 *    counter reset and produces nonsense. throttled_requests reads the gauge
 *    directly; the attribution rule is "> 0", not a rate.
 *  - SuccessfulRequestLatency counts only SUCCESSFUL calls, so the gap stops
 *    being interpretable once throttling starts -- by which point
 *    throttled_requests has already answered the question.
 *  - The subtrahend is PER ROUTE, from attribution.operations. A single
 *    avg() over the whole table averages unlike operations together and
 *    subtracts the same wrong number from every route -- see queueingExpr.
 */

const SRL = 'aws_dynamodb_successful_request_latency_average';

/**
 * queueing_ms_by_route: in-process db wall-clock minus DynamoDB's own clock,
 * per route, in milliseconds.
 *
 * The subtrahend must be built from `attribution.operations`, which is why that
 * block exists in slo.yaml. A single
 * `avg(SRL{dimension_TableName=...})` -- the form this file used to emit --
 * averages every operation on the table into one number and subtracts it
 * identically from all four routes. Measured 2026-09-01 on the live stack:
 * GetItem 0.912, PutItem 2.018, Query 1.1625, BatchWriteItem 0 (seeding, not
 * request traffic, and its zero drags the mean down) -> 1.023 subtracted
 * everywhere, where /reports needs Query + PutItem = 3.18. A 2 ms error on a
 * signal whose whole job is detecting a few ms of event-loop queueing is larger
 * than the signal.
 *
 * A request makes one call per listed operation and `marks` sums them (spec
 * section 3), so the comparison value is the SUM over the route's operations --
 * `/reports` issues Query then PutItem, so Query + PutItem. Each operation is
 * summed SEPARATELY and the sums added, rather than matched by one
 * `dimension_Operation=~"a|b"` regex: a route that issued the same operation
 * twice would need it counted twice, and a missing operation series must empty
 * the term rather than silently under-subtract.
 *
 * One expression covers all four routes, `or`-joined, each term carrying its own
 * `http_route` label -- `or` unions disjoint per-route vectors, so a route with
 * no traffic drops out of the result instead of emptying the whole query.
 *
 * `group_left ()` needs its empty parentheses. `on()` alone matches one-to-one
 * and drops every label not named in it, which would throw away the `http_route`
 * the panel legend is keyed on; but `group_left (` immediately followed by the
 * right-hand expression is a parse error -- the parser reads that `(` as the
 * group's label list ("unexpected \"(\" in grouping opts"). The empty list
 * closes it explicitly, verified live against Grafana Cloud.
 */
export function queueingExpr(doc) {
  const scope = SCOPE(doc);
  const routes = Object.values(classRatio(doc).classes).flatMap((c) => c.endpoints);
  return routes.map((endpoint) => {
    const route = doc.endpoints[endpoint];
    const ops = doc.attribution.operations[endpoint];
    const sel = `${DB}{${scope}, http_route="${route}"}`;
    const srl = ops
      .map((op) => `sum(${SRL}{dimension_TableName="${doc.service}", dimension_Operation="${op}"})`)
      .join('\n      + ');
    return `  (\n`
      + `    1000 * sum by (http_route) (histogram_sum(rate(${sel}[60s])))\n`
      + `    / sum by (http_route) (histogram_count(rate(${sel}[60s])))\n`
      + `    - on() group_left () (\n      ${srl}\n    )\n`
      + `  )`;
  }).join('\n  or\n');
}

export function renderQueries(doc) {
  const scope = SCOPE(doc);
  const vcpu = doc.attribution.vcpu_per_task;
  const q = {
    sli_ratio: ratioExpr(doc, { range: '$__rate_interval' }),

    db_wall_avg_by_route:
      `1000 * sum by (http_route) (histogram_sum(rate(${DB}{${scope}}[60s])))`
      + ` / sum by (http_route) (histogram_count(rate(${DB}{${scope}}[60s])))`,

    cloudwatch_srl_by_operation: `${SRL}{dimension_TableName="${doc.service}"}`,

    // The queueing signal, in milliseconds. Positive and growing means requests
    // are waiting on the event loop, not on DynamoDB. Subtrahend is per route,
    // from attribution.operations -- see queueingExpr.
    queueing_ms_by_route: queueingExpr(doc),

    // CPU-seconds burned per wall-second, per task.
    cpu_seconds_per_second: `sum by (instance) (histogram_sum(rate(${CPU}{${scope}}[60s])))`,

    // The same number as a fraction of the allocation. 1.0 is saturation.
    cpu_saturation_ratio: `sum by (instance) (histogram_sum(rate(${CPU}{${scope}}[60s]))) / ${vcpu}`,

    eventloop_delay_p99: `nodejs_eventloop_delay_p99_seconds{job="${doc.service}"}`,
    eventloop_delay_max: `nodejs_eventloop_delay_max_seconds{job="${doc.service}"}`,
    eventloop_utilization: `nodejs_eventloop_utilization_ratio{job="${doc.service}"}`,

    // A per-60s-period gauge, not a counter -- never rate() this one.
    throttled_requests:
      `sum(aws_dynamodb_throttled_requests_sum{dimension_TableName="${doc.service}"})`,
  };
  return `${JSON.stringify(q, null, 2)}\n`;
}

const OUTPUTS = [
  ['k6/lib/slo.js', renderK6],
  ['terraform/capacity.auto.tfvars', renderCapacityTfvars],
  ['grafana/classmap.json', renderClassMap],
  ['grafana/alerts.tf', renderAlerts],
  ['grafana/locals.tf', renderLocals],
  ['grafana/queries.json', renderQueries],
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('..', import.meta.url).pathname;
  const doc = loadSlo(`${root}slo.yaml`);
  const check = process.argv.includes('--check');
  let drifted = 0;
  for (const [rel, render] of OUTPUTS) {
    const wanted = render(doc);
    // A newly added output does not exist yet. That is drift, not a crash --
    // otherwise the run that is supposed to create the file dies reading it.
    let current = null;
    try { current = readFileSync(`${root}${rel}`, 'utf8'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (wanted === current) continue;
    drifted += 1;
    if (check) console.error(`DRIFT: ${rel} does not match slo.yaml`);
    else { writeFileSync(`${root}${rel}`, wanted); console.log(`wrote ${rel}`); }
  }
  if (check && drifted) process.exit(1);
  if (check) console.log('slo.yaml and its generated outputs agree');
}
