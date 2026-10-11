// scripts/measure-scan.js
// Times the heavy route's scan + aggregate against the rows that are ALREADY in
// the database, at several scan sizes, so "do I need more data?" is answered by
// a number. Read-only: it is the report statement without its INSERT.
//
// Run in the VPC through `./scripts/seed.sh --measure`, on the same image and
// settings as the service. The SQL below is a copy of the scan/agg CTEs in
// src/db.js report(); change one, change the other.
import { performance } from 'node:perf_hooks';

const RUNS = 5;
const STEPS = [1000, 5000, 10000, 25000, 50000, 100000, 200000, 500000];

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

export async function measure(prisma, { scanRows }) {
  const run = () => prisma.$queryRaw`
    WITH scanned AS (
      SELECT feed_id, score, body FROM posts ORDER BY id LIMIT ${scanRows}
    )
    SELECT count(*)::int AS n,
           coalesce(sum(length(body)), 0)::int AS bytes,
           count(DISTINCT feed_id)::int AS feeds,
           coalesce(avg(score), 0)::float AS avg_score
      FROM scanned`;
  await run(); // warm-up: the first read of a cold page is not the steady state
  const times = [];
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = performance.now();
    await run();
    times.push(performance.now() - t0);
  }
  return median(times);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { createPrisma } = await import('../src/db.js');
  const { createPool } = await import('../src/pool.js');
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  const { pool, close } = createPool({ config, onWait: () => {} });
  const prisma = createPrisma(pool);

  const [{ n }] = await prisma.$queryRaw`SELECT count(*)::int AS n FROM posts`;
  console.log(`posts in table: ${n}; report_scan_rows now: ${config.reportScanRows}; median of ${RUNS} runs after a warm-up`);
  const sizes = [...new Set([config.reportScanRows, ...STEPS, n])]
    .filter((s) => s > 0 && s <= n).sort((a, b) => a - b);
  for (const scanRows of sizes) {
    const ms = await measure(prisma, { scanRows });
    const tag = scanRows === config.reportScanRows ? '  <- current setting' : scanRows === n ? '  <- whole table' : '';
    console.log(`scan ${String(scanRows).padStart(7)} rows: ${ms.toFixed(1).padStart(8)} ms  (${(ms / (scanRows / 1000)).toFixed(2)} ms per 1000)${tag}`);
  }
  await prisma.$disconnect();
  await close();
}
