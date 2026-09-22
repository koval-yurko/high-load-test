// Forked from ecs-dynamodb-rps/infra/k6/tests/lib/mix.js on 2026-09-21.
// A bug fixed here does not reach the sibling copy; fix both.

// The provisional 55/15/25/5 mix, expressed deterministically over a 20-iteration
// cycle: 11 reads, 3 writes, 5 feeds, 1 report. Not Math.random() — sampling
// variance between runs would surface as a difference in the result, and this
// mix is the thing every recorded number is stated at.
//
// These ratios match slo.yaml's capacity.mix today, but that is a starting
// point rather than a decision: the mix is to be re-derived for the SQL
// workload rather than inherited from DynamoDB's cost model. Plan 3 confirms
// or changes it once hold times are measured. Deterministic rather than
// random, so two runs issue the same request sequence.
export const CYCLE = [
  'read', 'read', 'feed', 'read', 'write',
  'read', 'feed', 'read', 'read', 'feed',
  'write', 'read', 'feed', 'read', 'read',
  'report', 'feed', 'read', 'write', 'read',
];

export function pick(iteration) {
  return CYCLE[iteration % CYCLE.length];
}
