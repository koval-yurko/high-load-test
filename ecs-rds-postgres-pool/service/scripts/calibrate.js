// scripts/calibrate.js
// Measures all four routes and solves the two heavy-route knobs -- REPORT_SCAN_ROWS
// and its sleep -- so the mean hold across the mix lands on the target (spec 5). Run
// against the DEPLOYED instance, never locally -- the numbers are CPU- and
// instance-specific, exactly as the sibling's pbkdf2_iterations is.
//
// The search is pure and separately exported so it can be tested with no
// database. The measurement half cannot be, and is not faked.

const MAX_ITERATIONS = 20;

/**
 * The two knob positions, solved from measured per-route hold times.
 *
 * Little's law fixes the knee: knee = poolSize / meanHold. The database's CPU
 * load at that knee is knee x meanDbCpu, and relative to the instance's vCPUs
 * that is (knee x meanDbCpu) / vcpus. Setting it to targetCpuRelative and
 * substituting the knee cancels it out entirely:
 *
 *     meanDbCpu / meanHold  =  targetCpuRelative x vcpus / poolSize
 *
 * With the spec's 0.5, a db.t4g.micro's 2 vCPUs and a pool of 5 that is 0.2: at
 * most a fifth of each hold may be the database actually working, or the
 * database saturates before the pool does (plan 3, decision D1). Everything
 * below is that one line solved for the heavy route's two costs.
 *
 * The light routes' DB time is not measured separately -- their whole hold is
 * charged to the CPU budget, which is an over-estimate (it includes the round
 * trip and the pg/Prisma work) and therefore errs toward leaving MORE headroom
 * than the target. They are index hits, so the error is small.
 */
export function solveKnobs({ holds, mix, poolSize, vcpus, targetMeanHoldMs, targetCpuRelative }) {
  const share = (kind) => {
    const v = mix?.[kind];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`capacity.mix has no share for "${kind}" -- slo.yaml is the one source for the mix`);
    }
    return v;
  };
  const lightHoldMs = share('read') * holds.read + share('write') * holds.write + share('feed') * holds.feed;
  const reportShare = share('report');
  const cpuFraction = (targetCpuRelative * vcpus) / poolSize;
  const reportCpuMs = (targetMeanHoldMs * cpuFraction - lightHoldMs) / reportShare;
  const reportHoldMs = (targetMeanHoldMs - lightHoldMs) / reportShare;
  const feasible = reportCpuMs > 0 && reportHoldMs > reportCpuMs;
  const reason = reportCpuMs <= 0
    ? `the light routes alone spend ${lightHoldMs.toFixed(2)} ms of the ${(targetMeanHoldMs * cpuFraction).toFixed(2)} ms CPU budget per request`
    : reportHoldMs <= reportCpuMs
      ? 'the CPU cost needed already exceeds the whole hold: the mean hold target is too small for this mix'
      : '';
  return {
    cpuFraction, lightHoldMs, reportCpuMs, reportHoldMs,
    sleepMs: reportHoldMs - reportCpuMs,
    kneeRps: poolSize / (targetMeanHoldMs / 1000),
    feasible, reason,
  };
}

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

/**
 * The request mix, as the container receives it.
 *
 * NOT read from slo.yaml here, though slo.yaml remains its only source. The
 * image is built with service/ as the Docker context, so the project-root
 * slo.yaml is not in it, and `yaml` is a devDependency that `npm ci --omit=dev`
 * leaves out -- so a container that tried to parse it would fail at import time,
 * before measuring anything. The caller reads slo.yaml where the dev
 * dependencies live (scripts/run-oneoff.sh's caller, see the plan's Task 9) and
 * passes the result in as CAPACITY_MIX.
 *
 * Every share is required: solveKnobs divides by the report share, and a missing
 * one would silently size the whole experiment against three quarters of a
 * workload.
 */
export function readMix(env = process.env) {
  const raw = env.CAPACITY_MIX;
  if (!raw) {
    throw new Error('CAPACITY_MIX is required: pass the mix from slo.yaml (capacity.mix) as JSON, '
      + 'because slo.yaml itself is not in the image');
  }
  let mix;
  try { mix = JSON.parse(raw); } catch (err) {
    throw new Error(`CAPACITY_MIX is not valid JSON (${err.message})`);
  }
  for (const kind of ['read', 'write', 'feed', 'report']) {
    if (typeof mix?.[kind] !== 'number' || !Number.isFinite(mix[kind])) {
      throw new Error(`CAPACITY_MIX has no numeric share for "${kind}"`);
    }
  }
  return mix;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('../src/config.js');
  const { createPool } = await import('../src/pool.js');
  const { createPrisma, createRepo, buildPost } = await import('../src/db.js');

  const config = loadConfig();
  const { pool, warm, close } = createPool({ config, onWait: () => {} });
  const prisma = createPrisma(pool);
  const repo = createRepo({ prisma, config });
  await warm();

  // Median of five: one probe on a burstable instance is noise. Each probe of
  // the report route inserts a row, and nothing here resets the table -- the
  // growth is RECORDED instead, on every results.md row (plan 2, ruling R20).
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const timed = async (fn, n = 5) => {
    const samples = [];
    for (let i = 0; i < n; i += 1) {
      const t0 = process.hrtime.bigint();
      await fn();
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return median(samples);
  };

  const holds = {
    read: await timed(() => repo.getPost(1)),
    write: await timed(() => repo.createPost(buildPost(1))),
    feed: await timed(() => repo.feedPage(1, config.feedPageSize)),
    report: 0,
  };

  const poolSize = Number(process.env.POOL_MAX ?? config.poolMax);
  const vcpus = Number(process.env.DB_VCPUS ?? 2);
  const targetMeanHoldMs = Number(process.env.TARGET_MEAN_HOLD_MS ?? 20);
  const targetCpuRelative = Number(process.env.TARGET_CPU_RELATIVE ?? 0.5);
  const mix = readMix();
  const solved = solveKnobs({ holds, mix, poolSize, vcpus, targetMeanHoldMs, targetCpuRelative });

  if (!solved.feasible) {
    console.error(`\nUNUSABLE: ${solved.reason}.\n` +
      `Measured holds (ms): ${JSON.stringify(holds)}\n` +
      `The spec's own answer to this is section 13's first risk row: report it and re-examine the ` +
      `instance class or the pool size before running any comparison. Do NOT write a knob into dev.tfvars.`);
    await prisma.$disconnect(); await close(); process.exit(1);
  }

  // The scan is searched with the sleep at ZERO, so what is being measured is
  // the database's CPU cost alone. The sleep is added afterwards, in Terraform.
  const measure = async (rows) =>
    timed(() => repo.report({ scanRows: rows, sleepMs: 0, post: buildPost(1) }));

  // The scan cannot read more rows than the seed created: above SEED_ROWS every
  // probe reads the same whole table and hold time goes flat, so a search that
  // "converged" up there would report a row count that means nothing.
  const hi = config.seedRows;
  const search = await searchScanRows({ measure, targetMs: solved.reportCpuMs, hi, tolerance: solved.reportCpuMs * 0.05 });

  if (search.rows >= hi) {
    console.error(`\nUNUSABLE: the search pinned at ${hi} rows, the whole seeded table, and still ` +
      `reached only ${search.ms.toFixed(2)} ms against a ${solved.reportCpuMs.toFixed(2)} ms target.\n` +
      `Raise SEED_ROWS (watch the working set against shared_buffers) or make the aggregate cost ` +
      `more per row, then re-run. Do NOT write this number into dev.tfvars.`);
    await prisma.$disconnect(); await close(); process.exit(1);
  }

  const sleepMs = Math.round(solved.reportHoldMs - search.ms);
  console.log(JSON.stringify({
    holds, solved, search,
    knobs: { report_scan_rows: search.rows, report_sleep_ms: sleepMs },
    inputs: { poolSize, vcpus, targetMeanHoldMs, targetCpuRelative, mix },
  }, null, 2));
  console.log(`\nSet in infra/main/dev.tfvars:\n  report_scan_rows = ${search.rows}\n  report_sleep_ms  = ${sleepMs}`);
  console.log(`Predicted knee: ${solved.kneeRps.toFixed(0)} rps at pool ${poolSize}, with DBLoadCPU ~= ${targetCpuRelative} x ${vcpus} vCPUs.`);

  await prisma.$disconnect();
  await close();
}
