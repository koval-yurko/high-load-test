// scripts/generate-slo.js
// Forked from ecs-dynamodb-rps/service/scripts/generate-slo.js on 2026-09-20.
// A bug fixed here does not reach the sibling copy; fix both.
//
// Changed from the sibling, and only these:
//  - validateSlo() is split out of loadSlo() so the rules have one home and two
//    entry points, and it gained the null-threshold guard (see below).
//  - the sibling's capacity trio (capacityModel / readCapacityTfvars /
//    capacityReport) is replaced by renderCapacityAdvisory(): RCU/WCU has no
//    analogue, and all three read infra/main/dev.tfvars, which this project does
//    not have until plan 2.
//  - queueingExpr() is DROPPED, and renderQueries() is rebuilt on pool wait
//    rather than ported: see the note above renderQueries.
//  - validateSlo() takes requireThresholds, and the CLI takes --only-unblocked,
//    so the two threshold-free outputs can be written before plan 3 calibrates.
//
// The single source: slo.yaml -> k6 thresholds, Grafana alert rules, Alloy class
// map. Nothing downstream of this file is edited by hand.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  REQUEST_DURATION, DB_DURATION, CPU_DURATION,
  POOL_WAIT_DURATION, POOL_WAITING, POOL_IDLE, POOL_TOTAL,
} from '../src/otel.js';

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

/**
 * Every rule the document must satisfy, in one place.
 *
 * Split out of loadSlo (which the sibling keeps them inside) so there are two
 * entry points and ONE implementation: loadSlo calls this on the parsed file,
 * and a caller holding a document in memory -- the tests, and anything plan 3
 * writes to freeze the calibrated thresholds -- can ask the same question
 * without going through the filesystem. Duplicating the rules across the two
 * would mean a guard that holds on one path and not the other, which is worse
 * than no guard because both paths still read as checked.
 */
export function validateSlo(doc, { requireCapacityMix = false, requireThresholds = true } = {}) {
  if (doc.capacity) {
    // The sibling reads doc.capacity.mix unconditionally, which throws a
    // TypeError on a capacity block that has a pool and no mix -- the shape
    // every in-memory fixture here has. Guarding with `?.` alone would have
    // traded that TypeError for SILENCE: a slo.yaml that lost its `mix:` block
    // would validate clean, and capacity.mix is where the load profile's
    // request distribution comes from. So the key is REQUIRED of a document
    // read from disk -- the committed source of truth, which must be complete
    // -- and optional for one handed over pre-parsed, which is partial by
    // nature. loadSlo sets the flag from which of the two happened.
    if (doc.capacity.mix === undefined || doc.capacity.mix === null) {
      if (requireCapacityMix) {
        throw new Error('capacity is declared without capacity.mix; the load profile has no request distribution to read');
      }
    } else {
      const shares = Object.values(doc.capacity.mix);
      const total = shares.reduce((a, b) => a + b, 0);
      // A mix that does not sum to one produces capacity numbers that are quietly
      // wrong rather than obviously wrong. Refuse, do not round.
      if (Math.abs(total - 1) > 1e-9) throw new Error(`capacity.mix must sum to 1.0, got ${total}`);
    }
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

  // THE GUARD THIS PROJECT IS CURRENTLY RED ON, deliberately. slo.yaml ships
  // with every threshold_ms null: they are frozen in plan 3, from a calibration
  // run against the real db.t4g.micro, because the k6 VU sizing is derived from
  // them and a number invented now would be inventing the assertion. A null
  // threshold renders as `histogram_fraction(0, NaN, ...)` in PromQL and
  // `fast: null` in the k6 thresholds -- both of which parse, deploy, and
  // measure nothing. Refuse here instead, naming the class, so `slo:check` is
  // red for a reason a reader can act on.
  //
  // requireThresholds defaults to TRUE, so every caller that does not say
  // otherwise -- slo:check included -- keeps this guard. Only the CLI's
  // --only-unblocked turns it off, and it then writes only the outputs that do
  // not read a threshold. Every rule above still runs either way.
  for (const slo of requireThresholds ? (doc.slos ?? []) : []) {
    if (slo.sli !== 'class_threshold_ratio') continue;
    for (const [name, cls] of Object.entries(slo.classes)) {
      if (typeof cls.threshold_ms !== 'number' || !Number.isFinite(cls.threshold_ms)) {
        throw new Error(
          `class "${name}" has no threshold_ms (${JSON.stringify(cls.threshold_ms ?? null)}). `
          + 'Thresholds are calibrated and frozen in plan 3; until then slo:check is red on purpose.',
        );
      }
    }
  }

  return doc;
}

export function loadSlo(path, preParsed, { requireCapacityMix = preParsed === undefined, requireThresholds = true } = {}) {
  const doc = preParsed ?? parse(readFileSync(path, 'utf8'));
  // A document read from disk is the committed source of truth and has to be
  // complete; one passed in pre-parsed is a fixture and is partial on purpose.
  // The CLI parses the file itself, to print the advisory before validating, so
  // it passes the flag back explicitly -- otherwise the one document that must
  // be complete would be the one checked most loosely.
  validateSlo(doc, { requireCapacityMix, requireThresholds });
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
// literal 'rate>0.99' in the sibling until 2026-09-09 -- so the discovery run kept
// measuring the knee against 99% while slo.yaml said something else, silently.
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
 * The (pool size x task count) states the knob sequence actually visits.
 *
 * Built from slo.yaml alone -- baseline_size, released_size, task_counts --
 * and shaped to match the spec's knob table (section 6.2 of
 * docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md): baseline
 * runs the small pool at the first task count, then each knob releases the pool
 * and walks the task counts. With [1, 4] that is 5x1, 25x1, 25x4. Nothing is
 * invented here; a state this function does not know about is a key missing
 * from slo.yaml.
 */
export function plannedStates(doc) {
  const pool = doc.capacity?.pool ?? {};
  if (pool.baseline_size === undefined && pool.released_size === undefined) return [];
  const counts = Array.isArray(pool.task_counts) ? pool.task_counts : [];
  const states = [{ label: 'baseline', poolMax: pool.baseline_size, desiredCount: counts[0] }];
  counts.forEach((n, i) => states.push({ label: `knob ${i + 1}`, poolMax: pool.released_size, desiredCount: n }));
  return states;
}

/**
 * How many Postgres connections each planned state would actually open, said
 * out loud, as a matrix rather than as one cell.
 *
 * ADVISORY ONLY, like the sibling's capacity report since 2026-09-18, and for
 * the same reason: infra/main/dev.tfvars holds every sizing knob and wins
 * openly, so this model only says what it thinks. It NEVER contributes to the
 * exit code -- a hand-set pool that disagrees with slo.yaml is a choice, not
 * drift.
 *
 * It replaces capacityModel / readCapacityTfvars / capacityReport, which
 * computed DynamoDB RCU/WCU from a per-request cost table. There is no such
 * table here: the number that can take the database down is not provisioned
 * throughput, it is `pool max x tasks` against the instance's own
 * max_connections, which on a db.t4g.micro is small enough to reach by
 * accident.
 *
 * EVERY state, not the roomiest one. This printed `25 x 1 = 25, 22.3% of
 * estimate` until 2026-09-20 -- true of knob 1, and the state with the most
 * headroom of the three. A reader taking that in before an apply concludes
 * there is 4.5x of room, when knob 2 (25 x 4 = 100 of ~112) is the state the
 * project is explicitly driving toward and has about 12% left. The pool size
 * is only half the product; the task count is the other half, and pinning it to
 * the smallest value the sequence ever uses hid the whole finding.
 *
 * The second argument overrides the sequence with one state (or a list of
 * them), which is how plan 2 will price the real desired_count out of
 * infra/main/dev.tfvars. The no-argument form is what the CLI prints, and it is
 * the one that carries the ceiling warning.
 */
export function renderCapacityAdvisory(doc, states) {
  const estimate = doc.capacity?.pool?.max_connections_estimate ?? null;
  const availability = doc.slos?.find((s) => s.sli === 'success_rate');
  const rows = states === undefined ? plannedStates(doc)
    : Array.isArray(states) ? states
    : [{ label: 'requested', ...states }];

  // A state whose pool size or task count is missing renders UNSET rather than
  // multiplying into NaN. This block runs on the UNVALIDATED document, before
  // validateSlo has had a chance to refuse anything, precisely so that it still
  // prints when something else is wrong -- so it has to survive a document with
  // holes in it and stay readable.
  const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const cells = rows.map((s) => {
    const poolMax = finite(s.poolMax);
    const desiredCount = finite(s.desiredCount);
    return { label: s.label ?? 'requested', poolMax, desiredCount, total: poolMax === null || desiredCount === null ? null : poolMax * desiredCount };
  });
  const share = (total) => (total === null || estimate === null ? null : (total / estimate) * 100);
  const worst = cells.reduce((a, b) => (b.total !== null && (a === null || b.total > a.total) ? b : a), null);
  const marked = worst !== null && cells.length > 1;

  const lines = [
    'pool (advisory -- infra/main/dev.tfvars is authoritative; it arrives in plan 2):',
    `  max_connections_estimate ${String(estimate ?? 'UNSET').padStart(5)}   `
    + (estimate === null ? 'slo.yaml sets no estimate' : 'SHOW max_connections on the real instance'),
  ];
  if (cells.length === 0) lines.push('  capacity.pool is unset in slo.yaml -- there is nothing to size');
  for (const c of cells) {
    const size = c.poolMax === null ? 'UNSET' : String(c.poolMax).padStart(2);
    const tasks = c.desiredCount === null
      ? 'UNSET tasks' : `${c.desiredCount} task${c.desiredCount === 1 ? '' : 's'}`;
    const pct = share(c.total);
    lines.push(
      `  ${c.label.padEnd(9)} pool ${size} x ${tasks.padEnd(8)} = ${String(c.total ?? 'n/a').padStart(5)}`
      + (pct === null ? '' : `   ${`${pct.toFixed(1)}%`.padStart(6)} of estimate`)
      + (marked && c === worst ? '   <-- the ceiling check' : ''),
    );
  }
  if (marked && share(worst.total) !== null) {
    // The marker says WHICH row; these three lines say WHY it is the one to
    // read. A connection the server refuses is not a slow request, it is a 5xx,
    // so it lands on the availability objective -- the one with the smallest
    // budget -- and not on the latency classes this project spends its time on.
    lines.push(
      `  ^ the marked row is the tightest state the knob sequence visits. A connection`,
      '    refused there is `FATAL: sorry, too many clients already` -- a 5xx, so it burns',
      `    ${availability ? `the ${availability.objective}% availability budget` : 'the availability budget'}, not the latency one.`,
    );
  }
  return lines.join('\n');
}

/**
 * { "<route template>": "<class>" } -- what the collector's OTTL keys on.
 * Keyed by TEMPLATE, not endpoint name: slo.yaml is the human vocabulary,
 * http.route is the collector's, and this file is the join between them.
 * Unclassified routes (/healthz, and anything unmatched) are absent on purpose
 * -- the SLO query excludes them by selector.
 */
export function renderClassMap(doc) {
  const slo = classRatio(doc);
  const map = {};
  for (const [name, cls] of Object.entries(slo.classes)) {
    for (const endpoint of cls.endpoints) map[doc.endpoints[endpoint]] = name;
  }
  return `${JSON.stringify(map, null, 2)}\n`;
}

/**
 * OTel instrument name -> the Prometheus name Grafana Cloud's OTLP translation
 * gives it: dots become underscores, and unit `s` appends `_seconds`. Built from
 * the constants in src/otel.js rather than retyped -- the names drifted once
 * already. No `_bucket`/`_sum`/`_count` suffix: these are NATIVE histograms,
 * one series each (see renderQueries).
 */
const promSeconds = (otelName) => `${otelName.replace(/\./g, '_')}_seconds`;
const promGauge = (otelName) => otelName.replace(/\./g, '_');

const METRIC = promSeconds(REQUEST_DURATION);
/**
 * The SLO population: requests that belong to a latency class, and nothing else.
 *
 * The class selector is load-bearing, not decorative. The ALB is internet-facing,
 * so scanners probe it constantly -- the sibling measured 0.12 req/s of 404s on
 * unmatched paths, which was 68% of its window. Those requests pass an
 * http_route filter, carry no class, and so land in the denominator while
 * contributing nothing to the numerator: every one of them counts as an SLO
 * violation. It drove that project's measured miss rate to 66% and put three
 * burn rules into firing on background noise.
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
 * recording two different indicators under one name.
 *
 * 4xx is deliberately NOT a miss here: a client error is not charged to the
 * service. Unlike the sibling, this project has NO admission control, so no 4xx
 * is ever a shed request -- the 400s that exist are malformed input, which a
 * load profile does not send. Label name as Grafana Cloud's OTLP translation
 * emits it: http.response.status_code arrives as http_response_status_code.
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
    // fire. `vector(0)` carries no labels, exactly like
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
 * The sibling typed the objective and window into grafana/slo.tf by hand -- the
 * same numbers that live in slo.yaml, in a file `slo:check` did not read. That
 * is precisely the failure this generator exists to prevent: the SLO asserting
 * one number while the gate asserts another, both green, neither meaning
 * anything.
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
 * The runbook is this project's README "Is it about to break?" section -- the
 * anchor is GitHub's slug for that heading, so renaming the heading breaks the
 * link silently. NEITHER TARGET EXISTS YET: plan 2 writes the README and the
 * dashboard, and it owns both of these constants. The panel id is a placeholder
 * for this project's "SLI ratio" panel; it is a literal because the dashboard
 * JSON is hand-maintained and nothing generates its ids. The test asserts that
 * every rule carries a runbook link and a panel deep link, not that the id is
 * any particular number -- pinning a number for a dashboard that does not exist
 * would assert a fiction.
 */
const RUNBOOK_URL =
  'https://github.com/koval-yurko/high-load-test/blob/master/ecs-rds-postgres-pool/README.md#6-is-it-about-to-break';
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
    // dashboard that no longer exists after a recreate. Plan 2 must name its
    // dashboard resource grafana_dashboard.attribution or change this.
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

const DB = promSeconds(DB_DURATION);
const CPU = promSeconds(CPU_DURATION);
const POOL_WAIT = promSeconds(POOL_WAIT_DURATION);

/** True when every latency class has a finite threshold -- sli_ratio needs all of them. */
const thresholdsSet = (doc) => Object.values(classRatio(doc).classes)
  .every((c) => typeof c.threshold_ms === 'number' && Number.isFinite(c.threshold_ms));

/**
 * grafana/queries.json: every query the dashboard panels, /loadtest and the
 * README deep-links read, defined once.
 *
 * Ported from the sibling's renderQueries, with its two DynamoDB keys dropped
 * rather than translated: cloudwatch_srl_by_operation and queueing_ms_by_route
 * subtract DynamoDB's own server-side clock from the in-process db time, and
 * Postgres publishes no per-operation server-side latency to subtract. This
 * project measures the queue DIRECTLY instead -- db.pool.wait.duration, per
 * class (docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md,
 * "Three queues in series").
 *
 * The histograms are NATIVE: there is no `_sum{...}`/`_count{...}`/`_bucket{...}`
 * series to match. That form parses, returns "success", and matches nothing
 * forever. Quantiles come from histogram_quantile over rate() of the one native
 * series; sums and counts from histogram_sum/histogram_count. `sum by (...)`
 * wraps the rate before the quantile, or the label being grouped on is gone.
 *
 * Two keys are conditional, and both are omitted rather than rendered broken:
 *  - sli_ratio bakes the class thresholds into PromQL, so it appears only once
 *    every threshold_ms is set (plan 3). Before then it would render
 *    histogram_fraction(0, NaN, ...), which parses and measures nothing.
 *  - cpu_saturation_ratio divides by attribution.vcpu_per_task. A document
 *    without that key gets no ratio -- inventing a vCPU number would be
 *    inventing the denominator. cpu_seconds_per_second is always emitted.
 *    (Still owed from plan 1: a cross-check that vcpu_per_task equals
 *    infra/main/dev.tfvars task_cpu / 1024, since Terraform allocates it.)
 */
export function renderQueries(doc) {
  const scope = SCOPE(doc);
  const job = `job="${doc.service}"`;
  const vcpu = doc.attribution?.vcpu_per_task;
  const q = {};

  if (thresholdsSet(doc)) q.sli_ratio = ratioExpr(doc, { range: '$__rate_interval' });

  // THE project's central series: how long each class waited for a connection.
  // Per class because a global histogram cannot say whose requests queued --
  // /reports holding connections shows up as /posts/:id waiting.
  q.pool_wait_p99_by_class =
    `histogram_quantile(0.99, sum by (class) (rate(${POOL_WAIT}{${scope}}[60s])))`;

  // The same wait split by pool.opened: true means the checkout had to open a
  // connection (TCP, TLS, Postgres auth), false means it queued for one that
  // already existed. Only the second is the queue the pool knob moves.
  q.pool_wait_p99_opened =
    `histogram_quantile(0.99, sum by (pool_opened) (rate(${POOL_WAIT}{${scope}}[60s])))`;

  // Read BESIDE the histogram, not instead of it. `total` rising while waits
  // rise says setup, not queueing. One series per task; no labels to aggregate.
  q.pool_waiting = `${promGauge(POOL_WAITING)}{${job}}`;
  q.pool_idle = `${promGauge(POOL_IDLE)}{${job}}`;
  q.pool_total = `${promGauge(POOL_TOTAL)}{${job}}`;

  // In-process database time per route, milliseconds. Brackets an await, so it
  // includes pool wait AND event-loop queueing -- compare it against the two.
  q.db_wall_avg_by_route =
    `1000 * sum by (http_route) (histogram_sum(rate(${DB}{${scope}}[60s])))`
    + ` / sum by (http_route) (histogram_count(rate(${DB}{${scope}}[60s])))`;

  // CPU-seconds burned per wall-second, per task.
  q.cpu_seconds_per_second = `sum by (instance) (histogram_sum(rate(${CPU}{${scope}}[60s])))`;

  // The same number as a fraction of the allocation. 1.0 is saturation.
  if (typeof vcpu === 'number' && Number.isFinite(vcpu) && vcpu > 0) {
    q.cpu_saturation_ratio = `${q.cpu_seconds_per_second} / ${vcpu}`;
  }

  q.eventloop_delay_p99 = `nodejs_eventloop_delay_p99_seconds{${job}}`;
  q.eventloop_delay_max = `nodejs_eventloop_delay_max_seconds{${job}}`;
  q.eventloop_utilization = `nodejs_eventloop_utilization_ratio{${job}}`;

  return `${JSON.stringify(q, null, 2)}\n`;
}

// Capacity is deliberately NOT an output. infra/main/dev.tfvars sets the pool
// and task sizing by hand and outranks anything this script could write; the
// model only reports, via renderCapacityAdvisory above.
//
// Two of the five outputs do not depend on a calibrated threshold, and plan 2
// needs them before calibration happens: classmap.json is route -> class, which
// handlers.js already fixes, and queries.json's attribution keys are built on
// metric names. queries.json gains sli_ratio once thresholds exist. The other
// three bake threshold values into PromQL and k6 assertions, so they stay behind
// the null guard until plan 3 freezes them.
const OUTPUTS = [
  { path: 'infra/grafana/classmap.json', render: renderClassMap, needsThresholds: false },
  { path: 'infra/grafana/queries.json', render: renderQueries, needsThresholds: false },
  { path: 'infra/grafana/locals.tf', render: renderLocals, needsThresholds: true },
  { path: 'infra/grafana/alerts.tf', render: renderAlerts, needsThresholds: true },
  { path: 'infra/k6/tests/lib/slo.js', render: renderK6, needsThresholds: true },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('../..', import.meta.url).pathname;
  const check = process.argv.includes('--check');
  const onlyUnblocked = process.argv.includes('--only-unblocked');
  // --check is the guard. A flag that relaxes it would make it decorative, so
  // the combination is refused outright rather than quietly ignored.
  if (check && onlyUnblocked) {
    console.error('--check does not accept --only-unblocked: the check always validates every threshold');
    process.exit(2);
  }

  // Parsed, then validated separately, so the advisory below can print even
  // when the document is refused. Connections are the number that can exhaust
  // max_connections; a run that says nothing about them because some unrelated
  // field was wrong is a run that wasted its output.
  //
  // No second argument: the advisory prices EVERY state the knob sequence
  // visits, not one of them. Which state is being applied is not something this
  // script can know, and guessing produced the roomiest of the three.
  const raw = parse(readFileSync(`${root}slo.yaml`, 'utf8'));
  console.log(renderCapacityAdvisory(raw));

  let doc;
  try {
    // The document came off disk here, so it is held to the complete-document
    // rules even though loadSlo is handed the already-parsed copy.
    doc = loadSlo(null, raw, { requireCapacityMix: true, requireThresholds: !onlyUnblocked });
  } catch (err) {
    console.error(`slo.yaml is not valid: ${err.message}`);
    process.exit(1);
  }

  let drifted = 0;
  for (const { path: rel, render, needsThresholds } of OUTPUTS) {
    if (onlyUnblocked && needsThresholds) {
      console.log(`skipped ${rel}: it bakes class thresholds in, and slo.yaml's threshold_ms are unset until plan 3`);
      continue;
    }
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
