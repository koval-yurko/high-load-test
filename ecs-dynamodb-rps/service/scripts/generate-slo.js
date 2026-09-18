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

// The primary objective as a bare 0..1 rate, exported so a profile that needs it
// OUTSIDE the thresholds object below does not retype it. discovery.js does: it
// builds one threshold per step, plus an abortOnFail stop, and both were typed as
// literal 'rate>0.99' until 2026-09-09 -- so the discovery run kept measuring the
// knee against 99% while slo.yaml said something else, silently and for free.
export const SLO_MET_RATE = ${rate(slo.objective)};

export const thresholds = {
  // PRIMARY gate: >=${slo.objective.toFixed(1)}% of requests meet their own class threshold.
  slo_met: ['rate>${rate(slo.objective)}'],
  // TAIL: >=${slo.tail_objective.toFixed(1)}% meet ${slo.tail_multiplier}x their class threshold.
  slo_met_tail: ['rate>${rate(slo.tail_objective)}'],
  // Availability ${availability.objective}%. k6's rate metric counts FAILURES, so the objective inverts:
  // ${availability.objective}% success  ->  failure rate < ${rate(100 - availability.objective)}.
  http_req_failed: ['rate<${rate(100 - availability.objective)}'],
  // An arrival-rate run that exhausts its VUs does not slow down or fail: it
  // records dropped iterations and delivers LESS than RATE, then passes the SLO
  // at that lower rate. Such a run is not a measurement at RATE. Refuse it.
  dropped_iterations: ['count==0'],
  // Per class, REPORTED not gated. k6 prints a tagged sub-metric in the summary
  // only when some threshold references it, and every threshold sets the exit
  // code, so a threshold that cannot fail is the one form that shows p99 per
  // class without making it part of the verdict.
${Object.entries(slo.classes).map(([n]) => `  'http_req_duration{class:${n}}': ['p(99)>=0'],`).join('\n')}
};
`;
}

/**
 * What the capacity model in slo.yaml WOULD provision, per unit and in total.
 *
 * ADVISORY ONLY since 2026-09-18. Provisioned capacity is the single biggest
 * line on the bill, so it is hand-set in infra/main/dev.tfvars where the other
 * sizing knobs are, and this model only says what it thinks. It used to render
 * infra/main/capacity.auto.tfvars, which was byte-checked and therefore
 * unoverridable -- and which a -var-file on the CLI outranked anyway, so a
 * number in dev.tfvars won silently. There is now one file, and it wins openly.
 */
export function capacityModel(doc) {
  const { mix, cost_per_request: cost, target_rps: rps } = doc.capacity;
  const per = (unit) => Object.entries(mix).reduce((sum, [k, share]) => sum + share * (cost[k][unit] ?? 0), 0);
  const terms = (unit) => Object.entries(mix)
    .filter(([k]) => (cost[k][unit] ?? 0) > 0)
    .map(([k, share]) => `${share}*${cost[k][unit].toFixed(1)}`).join(' + ');
  const rcu = per('rcu'), wcu = per('wcu');
  return {
    rps,
    rcuPerRps: rcu, wcuPerRps: wcu,
    rcuTerms: terms('rcu'), wcuTerms: terms('wcu'),
    read: Math.round(rcu * rps), write: Math.round(wcu * rps),
  };
}

/**
 * The two capacity numbers as dev.tfvars actually sets them, or null for a
 * variable the file does not set. Null is a real answer, not an error: with no
 * capacity.auto.tfvars behind it, an unset variable has no default in
 * variables.tf and terraform will ask for it -- worth saying out loud.
 */
export function readCapacityTfvars(text) {
  const value = (name) => {
    // Anchored per line so a commented-out `# read_capacity = 25` is not read
    // as the setting. HCL allows any spacing around `=`.
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(\\d+)`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  return { read: value('read_capacity'), write: value('write_capacity') };
}

/** One line per unit: what is set, what the model says, and whether they agree. */
export function capacityReport(doc, tfvars) {
  const model = capacityModel(doc);
  const set = readCapacityTfvars(tfvars);
  const line = (unit, actual, wanted, terms, perRps) =>
    `  ${unit} dev.tfvars ${String(actual === null ? 'UNSET' : actual).padStart(5)}` +
    `  |  model ${String(wanted).padStart(5)}` +
    `  (${terms} = ${perRps.toFixed(3)}/rps x ${model.rps} rps)` +
    `${actual === wanted ? '' : '  <- differs'}`;
  return [
    'capacity (advisory -- dev.tfvars is authoritative):',
    line('RCU', set.read, model.read, model.rcuTerms, model.rcuPerRps),
    line('WCU', set.write, model.write, model.wcuTerms, model.wcuPerRps),
  ].join('\n');
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

/**
 * What a "good" request is, beyond being fast: not a server error. Applied to
 * the NUMERATOR only -- a 5xx stays in the denominator and so counts as a miss,
 * which is what k6's slo_met does (it requires a 2xx before it looks at the
 * duration). Without this a request that fails in 3 ms sits inside
 * histogram_fraction and is scored as meeting its class, and results.md ends up
 * recording two different indicators under one name. 4xx is deliberately NOT a
 * miss here: a client error is not charged to the service (decided 2026-09-02,
 * recorded in slo.yaml). Label name verified live against Grafana Cloud the
 * same day: http.response.status_code arrives as http_response_status_code.
 */
const GOOD = 'http_response_status_code!~"5.."';

/** Proportion of requests meeting their own class threshold, over `range`. */
export function ratioExpr(doc, { multiplier = 1, range, job }) {
  const slo = classRatio(doc);
  const base = job ? SCOPE(doc).replace(`job="${doc.service}"`, `job="${job}"`) : SCOPE(doc);
  const good = Object.entries(slo.classes).map(([name, c]) => {
    const bound = ((c.threshold_ms * multiplier) / 1000);
    const sel = `${METRIC}{${base}, class="${name}", ${GOOD}}`;
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

/**
 * The availability SLI: non-5xx requests over all requests, same population as
 * the latency ratio. Native histograms carry the count, so this is
 * histogram_count over histogram_count -- no _count series exists to read.
 * `or vector(0)` for the same reason ratioExpr needs it: a window with only
 * failures would otherwise return an empty numerator and no alert.
 */
export function availabilityMissExpr(doc, { range }) {
  const scope = SCOPE(doc);
  return `1 - (\n`
    + `  (histogram_count(sum(rate(${METRIC}{${scope}, ${GOOD}}[${range}]))) or vector(0))\n`
    + `  /\n`
    + `  histogram_count(sum(rate(${METRIC}{${scope}}[${range}])))\n`
    + `)`;
}

/**
 * Where an alert points the person it wakes.
 *
 * The runbook is the README's "Is it about to break?" section -- the anchor is
 * GitHub's slug for that heading, so renaming the heading breaks the link
 * silently. The panel id is the dashboard's "SLI ratio: proportion meeting
 * per-class threshold" panel, which is the exact series every one of these six
 * rules alerts on; it is a literal here because dashboard.json.tftpl is
 * hand-maintained JSON and nothing generates its ids.
 */
const RUNBOOK_URL =
  'https://github.com/koval-yurko/high-load-test/blob/master/ecs-dynamodb-rps/README.md#6-is-it-about-to-break';
const SLI_RATIO_PANEL_ID = 19;

export function renderAlerts(doc) {
  const slo = classRatio(doc);
  const availability = doc.slos.find((s) => s.sli === 'success_rate');
  const blocks = [];
  for (const [kind, burn] of Object.entries(doc.burn)) {
    // [resource suffix, human label, objective %, expression]
    const objectives = [
      ['latency_classes_primary', 'latency-classes primary', slo.objective,
        missExpr(doc, { multiplier: 1, range: burn.window })],
      ['latency_classes_tail', 'latency-classes tail', slo.tail_objective,
        missExpr(doc, { multiplier: slo.tail_multiplier, range: burn.window })],
    ];
    if (availability) {
      objectives.push(['availability', 'availability', availability.objective,
        availabilityMissExpr(doc, { range: burn.window })]);
    }
    for (const [suffix, label, objective, expr] of objectives) {
      const sustainable = (100 - objective) / 100;
      const threshold = Number((burn.multiplier * sustainable).toFixed(6));
      const sloLabel = label.replace(/ /g, '-');
      blocks.push(`resource "grafana_rule_group" "${suffix}_${kind}burn" {
  name             = "${doc.service} / ${label} / ${kind} burn"
  folder_uid       = grafana_folder.project.uid
  interval_seconds = 60

  rule {
    name      = "${label} burn rate >= ${burn.multiplier}x over ${burn.window}"
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
          ${expr.split('\n').join('\n          ')}
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

    // Explicit, not inherited. Without this block the rule reaches whatever the
    // stack's ROOT notification policy names -- a default declared nowhere in
    // this repo, which another project's edit can redirect with no diff here.
    // The contact point is the one the stack already has; nothing is created.
    // group_by adds slo so primary, tail and availability arrive separately.
    notification_settings {
      contact_point = var.alert_contact_point
      group_by      = ["alertname", "slo"]
    }

    // runbook_url and the two __-prefixed keys turn the Slack message into two
    // clicks. __dashboardUid__/__panelId__ are Grafana's own convention, not
    // ours: given both, the alert renders a "View panel" link straight to panel
    // ${SLI_RATIO_PANEL_ID}, the SLI ratio these rules alert on. __dashboardUid__ is an HCL
    // REFERENCE, not a string -- hardcoding the uid would silently point at a
    // dashboard that no longer exists after a recreate.
    annotations = {
      summary          = "${label} (${objective}% objective) burning error budget ~${burn.multiplier}x sustainable over ${burn.window}."
      computation      = "window ${doc.window}; sustainable miss rate = 1 - ${objective / 100} = ${(sustainable * 100).toFixed(3)}%; ${kind}-burn threshold = ${burn.multiplier} * ${(sustainable * 100).toFixed(3)}% = ${(threshold * 100).toFixed(3)}%; alert window ${burn.window} = ${burn.budgetFraction * 100}% of budget"
      runbook_url      = "${RUNBOOK_URL}"
      __dashboardUid__ = grafana_dashboard.attribution.uid
      __panelId__      = "${SLI_RATIO_PANEL_ID}"
    }
    labels = {
      severity = "${burn.severity}"
      slo      = "${sloLabel}"
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
# Three objectives, two speeds each: latency-classes primary and tail (the
# per-class threshold ratio, a 5xx counted as a miss), and availability (non-5xx
# over all). The SLI is emitted by the service continuously -- these rules do
# not depend on a k6 run having happened.

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
 *  - SuccessfulRequestLatency counts only SUCCESSFUL calls, so the gap stops
 *    being interpretable once throttling starts -- by which point the throttle
 *    panel and the throttle alert rule, both reading CloudWatch live, have
 *    already answered the question. No throttle query is generated here: see
 *    the note where they used to be, in renderQueries.
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
      // `max by (dimension_TableName)`, not `sum` and not `max without
      // (instance)`. `sum` double-counts across an overlapping pair of collector
      // tasks during a redeploy. `without (instance)` fixes that but KEEPS
      // dimension_Operation -- so the two-operation subtrahend for /reports adds
      // series whose label sets differ, matches nothing, and renders EMPTY
      // (verified against live Prometheus, 2026-09-01). Aggregating BY the one
      // label both terms share leaves a single series that still adds, and that
      // `- on() group_left ()` can still match against.
      .map(
        (op) =>
          `max by (dimension_TableName) (${SRL}{dimension_TableName="${doc.service}", dimension_Operation="${op}"})`,
      )
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

    // `max`, never `sum`: every aws_* series carries an `instance` label naming
    // the Alloy task that scraped it. desired_count is 1, so sum() is right at
    // steady state -- but a replaced collector's series overlap the new task's
    // during a redeploy and every sum() reads double. Grouping BY the two
    // dimensions keeps one series per operation, which is what this breakdown is.
    cloudwatch_srl_by_operation:
      `max by (dimension_TableName, dimension_Operation) (${SRL}{dimension_TableName="${doc.service}"})`,

    // The queueing signal, in milliseconds. It is time spent inside the process
    // around the await, and it includes AWS SDK retry backoff on throttled
    // DynamoDB calls -- so while throttle events are non-zero it is not evidence
    // about the event loop. Subtrahend is per route, from attribution.operations
    // -- see queueingExpr.
    queueing_ms_by_route: queueingExpr(doc),

    // CPU-seconds burned per wall-second, per task.
    cpu_seconds_per_second: `sum by (instance) (histogram_sum(rate(${CPU}{${scope}}[60s])))`,

    // The same number as a fraction of the allocation. 1.0 is saturation.
    cpu_saturation_ratio: `sum by (instance) (histogram_sum(rate(${CPU}{${scope}}[60s]))) / ${vcpu}`,

    eventloop_delay_p99: `nodejs_eventloop_delay_p99_seconds{job="${doc.service}"}`,
    eventloop_delay_max: `nodejs_eventloop_delay_max_seconds{job="${doc.service}"}`,
    eventloop_utilization: `nodejs_eventloop_utilization_ratio{job="${doc.service}"}`,

    // No throttle queries here, deliberately. Read and write throttle events are
    // read LIVE from CloudWatch by everything that wants them -- the dashboard's
    // throttle panel, the throttle alert rule in grafana/throttles.tf, and
    // /loadtest -- so Alloy no longer forwards a Prometheus copy for anything to
    // query. Adding one back here means adding the metric{} block back to
    // alloy.alloy.tftpl too, or the query renders empty.
  };
  return `${JSON.stringify(q, null, 2)}\n`;
}

// Capacity is deliberately NOT here. infra/main/dev.tfvars sets read_capacity /
// write_capacity by hand and outranks anything this script could write; the
// model only reports, via capacityReport below.
const OUTPUTS = [
  ['infra/k6/tests/lib/slo.js', renderK6],
  ['infra/grafana/classmap.json', renderClassMap],
  ['infra/grafana/alerts.tf', renderAlerts],
  ['infra/grafana/locals.tf', renderLocals],
  ['infra/grafana/queries.json', renderQueries],
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('../..', import.meta.url).pathname;
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
  // Printed in BOTH modes and before the exit, so a run that is failing on
  // drift still says what capacity is set to -- that is the number on the bill.
  // It never touches `drifted`: a hand-set capacity that disagrees with the
  // model is a choice, not drift.
  console.log(capacityReport(doc, readFileSync(`${root}infra/main/dev.tfvars`, 'utf8')));
  if (check && drifted) process.exit(1);
  if (check) console.log('slo.yaml and its generated outputs agree');
}
