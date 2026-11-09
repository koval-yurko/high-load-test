'use strict';
// The sizing arithmetic of the spec, section "Sizing". Reserved concurrency with no queue
// is an Erlang loss system: B(C, A) is the fraction of requests refused (throttled).
const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { loadSlo, SLO_PATH } = require('./generate-slo');

function erlangB(c, A) {
  let b = 1;
  for (let k = 1; k <= c; k++) b = (A * b) / (k + A * b);
  return b;
}

function minConcurrency(A, target) {
  let c = 1;
  while (erlangB(c, A) > target) c++;
  return c;
}

/** Largest λ (RPS) for which C slots at mean duration d keep B <= target. Bisection. */
function maxRate(c, d, target) {
  let lo = 0;
  let hi = (c / d) * 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (erlangB(c, mid * d) <= target) lo = mid; else hi = mid;
  }
  return lo;
}

// 0.5 RCU per 4 KB, eventually consistent. Query rounding by TOTAL size is not verified
// (spec, "Unverified"); plan 3 phase 0 measures it.
const rcu = (bytes) => 0.5 * Math.ceil(bytes / 4096);
function rcuPerRequest({ itemsPerFeed, itemsPerReport, itemBytes }, mix) {
  return mix.fast * rcu(itemBytes) + mix.standard * rcu(itemsPerFeed * itemBytes) + mix.heavy * rcu(itemsPerReport * itemBytes);
}

function main() {
  const { values: v } = parseArgs({
    options: {
      c: { type: 'string' }, d: { type: 'string' }, rps: { type: 'string' },
      target: { type: 'string', default: '0.005' }, manifest: { type: 'string' },
      headroom: { type: 'string', default: '0.2' },
    },
  });
  const c = Number(v.c); const d = Number(v.d); const target = Number(v.target);
  if (!(c > 0 && d > 0)) throw new Error('usage: capacity --c <reserved> --d <mean Duration, s> [--rps N] [--target 0.005] [--manifest file]');
  const out = { reserved: c, meanDurationS: d, target, maxRpsAtTarget: Math.floor(maxRate(c, d, target)), naiveCeiling: Math.floor(c / d) };
  if (v.rps) {
    const A = Number(v.rps) * d;
    Object.assign(out, { rps: Number(v.rps), A, throttledFraction: erlangB(c, A), minReservedForTarget: minConcurrency(A, target) });
  }
  if (v.manifest) {
    const { params } = JSON.parse(fs.readFileSync(v.manifest, 'utf8'));
    const r = rcuPerRequest(params, loadSlo(SLO_PATH).mix);
    out.rcuPerRequest = r;
    if (v.rps) {
      out.rcuMean = Number(v.rps) * r;
      out.rcuProvisioned = Math.ceil(out.rcuMean * (1 + Number(v.headroom)));
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { erlangB, minConcurrency, maxRate, rcuPerRequest };
