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
  // An arrival-rate run that exhausts its VUs does not slow down or fail: it
  // records dropped iterations and delivers LESS than RATE, then passes the SLO
  // at that lower rate. Such a run is not a measurement at RATE. Refuse it.
  dropped_iterations: ['count==0'],
  // Per class, REPORTED not gated. k6 prints a tagged sub-metric in the summary
  // only when some threshold references it, and every threshold sets the exit
  // code, so a threshold that cannot fail is the one form that shows p99 per
  // class without making it part of the verdict.
  'http_req_duration{class:fast}': ['p(99)>=0'],
  'http_req_duration{class:standard}': ['p(99)>=0'],
  'http_req_duration{class:heavy}': ['p(99)>=0'],
};
