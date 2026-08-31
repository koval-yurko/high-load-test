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
 * Unclassified routes (/healthz, /stats) are absent on purpose -- the SLO
 * query excludes them by selector.
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
 * two health endpoints, though the class selector already subsumes it.
 */
const CLASSES = (doc) => Object.keys(classRatio(doc).classes).join('|');
const SCOPE = (doc) => `job="${doc.service}", http_route!~"/healthz|/stats", class=~"${CLASSES(doc)}"`;

/** Proportion of requests meeting their own class threshold, over `range`. */
export function ratioExpr(doc, { multiplier = 1, range, job }) {
  const slo = classRatio(doc);
  const base = job ? SCOPE(doc).replace(`job="${doc.service}"`, `job="${job}"`) : SCOPE(doc);
  const good = Object.entries(slo.classes).map(([name, c]) => {
    const bound = ((c.threshold_ms * multiplier) / 1000);
    const sel = `${METRIC}{${base}, class="${name}"}`;
    return `    sum(histogram_fraction(0, ${bound}, rate(${sel}[${range}])) * histogram_count(rate(${sel}[${range}])))`;
  }).join('\n  +\n');
  return `(\n${good}\n  )\n  /\n  sum(histogram_count(rate(${METRIC}{${base}}[${range}])))`;
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

const OUTPUTS = [
  ['k6/lib/slo.js', renderK6],
  ['terraform/capacity.auto.tfvars', renderCapacityTfvars],
  ['grafana/classmap.json', renderClassMap],
  ['grafana/alerts.tf', renderAlerts],
  ['grafana/locals.tf', renderLocals],
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
