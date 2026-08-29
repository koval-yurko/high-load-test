// GENERATED from slo.yaml by /slo. Do not edit by hand.
export const CLASS_THRESHOLD_MS = { fast: 50, standard: 200, heavy: 800 };
export const TAIL_MULTIPLIER = 3;

export const thresholds = {
  // PRIMARY gate: >=99.0% of requests meet their own class threshold.
  slo_met: ['rate>0.99'],
  // TAIL: >=99.9% meet 3x their class threshold.
  slo_met_tail: ['rate>0.999'],
  // Availability 99.9%. k6's rate metric counts FAILURES, so the objective inverts:
  // 99.9% success  ->  failure rate < 0.001.
  http_req_failed: ['rate<0.001'],
  // Secondary, per class. Diagnostic only — these are NOT the gate.
  'http_req_duration{class:fast}': ['p(99)<50'],
  'http_req_duration{class:standard}': ['p(99)<200'],
  'http_req_duration{class:heavy}': ['p(99)<800'],
};
