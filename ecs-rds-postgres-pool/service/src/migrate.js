// src/migrate.js
//
// `prisma migrate deploy` at boot, retried while the database is unreachable (Prisma P1001).
// A fresh RDS Proxy accepts the connection attempt for several minutes before it can serve
// one, and a task that exits then trips the ECS circuit breaker (seen 2026-11-03). Any other
// failure -- a bad migration, a bad password -- is NOT retried: it fails at once.
import { spawnSync } from 'node:child_process';

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// `ecs.tf` health_check_grace_period_seconds must stay above timeoutMs, or the load balancer
// stops the task while it is still waiting.
export async function migrateWithRetry({
  run = () => {
    const r = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { encoding: 'utf8' });
    return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  },
  sleep = sleepMs,
  now = Date.now,
  timeoutMs = 8 * 60_000,
  intervalMs = 10_000,
  log = console.log,
} = {}) {
  const deadline = now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    const { status, output } = run();
    if (output) log(output);
    if (status === 0) return attempt;
    if (!output.includes('P1001') || now() + intervalMs > deadline) {
      throw new Error(`prisma migrate deploy failed (exit ${status}, attempt ${attempt})`);
    }
    log(`database unreachable (P1001), retrying in ${intervalMs / 1000}s (attempt ${attempt})`);
    await sleep(intervalMs);
  }
}
