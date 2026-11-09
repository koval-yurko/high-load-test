// GENERATED from slo.yaml by npm run slo:generate. Do not edit by hand.
// Thresholds frozen: false.
export const CLASS_THRESHOLD_MS = {"fast":300,"standard":400,"heavy":1000};
export const LATENCY_RATE = 0.95;
export const AVAILABILITY_RATE = 0.99;
export const MIX = {"fast":0.7,"standard":0.25,"heavy":0.05};

// The gates for the samples matching one tag selector, e.g. 'window:measured'. Only
// judged users add samples to slo_met and slo_available (lib/request.js).
export function gate(selector) {
  return {
    [`slo_met{${selector}}`]: [`rate>=${LATENCY_RATE}`],
    [`slo_available{${selector}}`]: [`rate>=${AVAILABILITY_RATE}`],
    // An arrival-rate run that runs out of VUs delivers less than its rate and then
    // passes at that lower rate. Such a run is not a measurement. Refuse it.
    dropped_iterations: ['count==0'],
    // Reported, not gated: a threshold that cannot fail makes k6 print the sub-metric.
    [`http_req_duration{class:fast,${selector}}`]: ['p(95)>=0', 'p(99)>=0'],
    [`http_req_duration{class:standard,${selector}}`]: ['p(95)>=0', 'p(99)>=0'],
    [`http_req_duration{class:heavy,${selector}}`]: ['p(95)>=0', 'p(99)>=0'],
    [`rate_limited{${selector}}`]: ['rate>=0'],
  };
}
