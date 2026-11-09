// 14 fast, 5 standard, 1 heavy = 70/25/5, slo.yaml's mix. Deterministic over the
// iteration index; thinning then picks a random subset, which keeps the shares.
export const CYCLE = [
  'fast', 'fast', 'standard', 'fast', 'fast',
  'fast', 'standard', 'fast', 'fast', 'standard',
  'fast', 'fast', 'standard', 'fast', 'fast',
  'heavy', 'standard', 'fast', 'fast', 'fast',
];

export const classOf = (iteration) => CYCLE[iteration % CYCLE.length];
