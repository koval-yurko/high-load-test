// The frozen 55/15/25/5 mix, expressed deterministically over a 20-iteration
// cycle: 11 reads, 3 writes, 5 feeds, 1 report. Not Math.random() — sampling
// variance between runs would surface as a difference in the result, and this
// mix is the thing every recorded number is stated at.
export const CYCLE = [
  'read', 'read', 'feed', 'read', 'write',
  'read', 'feed', 'read', 'read', 'feed',
  'write', 'read', 'feed', 'read', 'read',
  'report', 'feed', 'read', 'write', 'read',
];

export function pick(iteration) {
  return CYCLE[iteration % CYCLE.length];
}
