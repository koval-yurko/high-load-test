// scripts/calibrate.js
// Finds the REPORT_SCAN_ROWS that makes the heavy route hold a connection for
// the target time (spec 5). Run against the DEPLOYED instance, never locally --
// the number is CPU- and instance-specific, exactly as the sibling's
// pbkdf2_iterations is.
//
// The search is pure and separately exported so it can be tested with no
// database. The measurement half cannot be, and is not faked.

const MAX_ITERATIONS = 20;

export async function searchScanRows({ measure, targetMs, lo = 0, hi = 200_000, tolerance = 0.5 }) {
  let best = { rows: hi, ms: await measure(hi), iterations: 0 };
  let iterations = 0;

  while (lo <= hi && iterations < MAX_ITERATIONS) {
    iterations += 1;
    const mid = Math.floor((lo + hi) / 2);
    const ms = await measure(mid);
    if (Math.abs(ms - targetMs) < Math.abs(best.ms - targetMs)) best = { rows: mid, ms, iterations };
    // Return `best`, never `mid`. Landing inside the tolerance band is the stop
    // condition, not a claim of being the closest probe: an earlier step can
    // already have measured a row count nearer the target, and the line above
    // has kept it. Returning mid here would discard it.
    if (Math.abs(ms - targetMs) <= tolerance) return { ...best, iterations };
    if (ms < targetMs) lo = mid + 1; else hi = mid - 1;
  }
  return { ...best, iterations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('../src/config.js');
  const { createPool } = await import('../src/pool.js');
  const { createPrisma, createRepo } = await import('../src/db.js');

  const config = loadConfig();
  const { pool, warm, close } = createPool({ config, onWait: () => {} });
  const prisma = createPrisma(pool);
  const repo = createRepo({ prisma, config });
  await warm();

  // Median of five, because one probe on a burstable instance is noise.
  //
  // This measures the WHOLE heavy route's statement -- scan, aggregate AND
  // insert -- because that is what holds the connection in production. Timing
  // the scan alone would calibrate against a cheaper statement than the one the
  // load test actually issues.
  //
  // Note that each probe inserts a row, so a long calibration grows the table
  // it is scanning. At five probes per step and ~14 steps that is ~70 rows
  // against tens of thousands, which is inside the noise -- but re-seed before
  // the baseline run rather than measuring on a table this script has grown.
  // The same instruction, for the load runs themselves, is in slo.yaml beside
  // the capacity block, where the operator will actually meet it.
  const { buildPost } = await import('../src/db.js');
  const measure = async (rows) => {
    const samples = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = process.hrtime.bigint();
      await repo.report({ scanRows: rows, post: buildPost(1) });
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return samples.sort((a, b) => a - b)[2];
  };

  const targetMs = Number(process.env.TARGET_HOLD_MS ?? 20);
  // The scan cannot read more rows than the seed created, so the search range
  // is capped by the table, not by the default. Without this the search would
  // happily "converge" above SEED_ROWS, where hold time is flat because every
  // probe reads the same whole table -- and report a row count that means
  // nothing.
  const hi = config.seedRows;
  const result = await searchScanRows({ measure, targetMs, hi });

  if (result.rows >= hi) {
    console.error(
      `\nUNUSABLE: the search pinned at ${hi} rows, the whole seeded table, and still ` +
      `reached only ${result.ms.toFixed(2)} ms against a ${targetMs} ms target.\n` +
      `The knob cannot reach the target at this table size. Raise SEED_ROWS (watch the ` +
      `working set against shared_buffers) or make the aggregate cost more per row, ` +
      `then re-run. Do NOT write this number into dev.tfvars.`,
    );
    process.exit(1);
  }

  console.log(JSON.stringify({ ...result, targetMs, searchCeiling: hi }, null, 2));
  console.log('\nSet REPORT_SCAN_ROWS in infra/main/dev.tfvars, and record the date and instance class beside it.');

  await prisma.$disconnect();
  await close();
}
