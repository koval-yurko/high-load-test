// Upload-time defaults, so a test stored in Grafana Cloud k6 is runnable from the
// UI with no -e flags. `-e` still wins for a local run -- nothing about running
// from a terminal changes.
//
// These are the only guessable values in the load profiles. Keep them honest:
//
//   BASE_URL  is NEVER the real endpoint. This repo is public and the ALB is
//             internet-facing with no TLS and no auth, so the deployed hostname
//             does not go in git. The fallback below is a dead local address: a
//             run that reaches it fails immediately with connection errors,
//             which is the correct behaviour for a misconfigured run.
//             The real value comes from one of two places, neither in git:
//               - local runs:  -e BASE_URL="$BASE_URL" out of the root .env
//               - UI runs:     Performance Testing (k6) -> Settings ->
//                              Environment variables
//
//   RATE      is the DISCOVERED knee, and discovery has not run yet. The default
//             below is therefore the discovery START rate, not a guess at the
//             ceiling: a rate the service is known to serve. Update it once
//             discovery has measured the knee, then re-upload -- otherwise a
//             UI-started constant/stress run measures the wrong thing.
export const DEFAULT_BASE_URL = 'http://localhost:1';
export const DEFAULT_RATE = 50;

export const BASE_URL = __ENV.BASE_URL || DEFAULT_BASE_URL;
export const RATE = Number(__ENV.RATE || DEFAULT_RATE);

// What replaces the `throw` these profiles used to carry. The guess is no longer
// prevented -- it is labelled, on every sample, so a run started from the UI at
// the default rate is distinguishable in the results from one given a measured
// knee. A row in results.md whose run carries rate_source=default is not a
// capacity measurement.
export const RATE_SOURCE = __ENV.RATE ? 'explicit' : 'default';

// traffic_source in the service keys on a `k6/` PREFIX (trafficSource() in
// src/otel.js). k6 v1.4.0's own default user-agent is "Grafana k6/1.4.0", which
// contains `k6/` without starting with it, so both 2026-09-01 runs landed under
// `other` and selecting traffic_source="k6" returned an empty series that reads
// exactly like a healthy silence. This must be an OPTION rather than the
// --user-agent CLI flag: a run started from the Grafana Cloud UI passes no flags.
export const USER_AGENT = 'k6/1.4.0';
