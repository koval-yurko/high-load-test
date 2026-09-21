// src/server.js
// Forked in shape from ecs-dynamodb-rps/service/src/server.js on 2026-09-20.
// Differences: no admission control (spec S3 -- shedding 429s would stop a
// saturated pool ever producing the 5xx this project measures), and the pool is
// pre-warmed before listen.
import http from 'node:http';
import { loadConfig } from './config.js';
import { createPool } from './pool.js';
import { createPrisma, createRepo } from './db.js';
import { createHandlers, matchRoute, ROUTE_CLASS } from './handlers.js';
import { createTimer } from './timing.js';
import { runInRequestContext } from './context.js';
import { startTelemetry } from './otel.js';
import { startEluPublisher } from './cloudwatch.js';

// Mirrors the sibling's cap (ecs-dynamodb-rps/service/src/server.js): an
// unbounded body on a public-internet-facing load balancer is a
// memory-exhaustion path.
const MAX_BODY_BYTES = 16 * 1024;

const send = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

async function readJson(req) {
  if (req.method !== 'POST') return undefined;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(c);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createServer({ handlers, telemetry, config }) {
  return http.createServer(async (req, res) => {
    // OUTER GUARD. Everything below -- new URL, matchRoute, send, and
    // recordRequest -- sits outside the inner try, and this callback is async,
    // so a throw out there is an unhandled rejection. Node 22 terminates the
    // process on one by default, which during a load run is a hole in the data
    // and a task restart, not a 5xx. A 5xx is a miss this project WANTS to
    // count; a dead task is a gap it cannot measure at all.
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = matchRoute(req.method, url.pathname);
      if (!route) return send(res, 404, { error: 'not found' });

      const cls = ROUTE_CLASS[route.name];
      const timer = createTimer();
      const t0 = process.hrtime.bigint();

      // The context wraps the WHOLE handler, so a pool checkout anywhere inside
      // it -- including inside Prisma's own call stack -- can name this request.
      await runInRequestContext({ route: route.template, class: cls }, async () => {
        let status = 500;
        let body = { error: 'internal' };
        try {
          const parsed = await readJson(req);
          const out = await handlers[route.name]({ params: route.params, body: parsed, timer });
          status = out.status;
          body = out.body;
        } catch (err) {
          if (err instanceof SyntaxError) { status = 400; body = { error: 'malformed json' }; }
          // Anything else stays a 500. A 5xx is a miss however fast it was, and
          // that is deliberate: a pool that times out under load SHOULD burn the
          // availability budget.
        }
        send(res, status, body);
        telemetry.recordRequest({
          route: route.template,
          class: cls,
          method: req.method,
          status,
          seconds: Number(process.hrtime.bigint() - t0) / 1e9,
          userAgent: req.headers['user-agent'],
          phases: timer.phases(),
        });
      });
    } catch (err) {
      // Best effort: the response may already be partly written, in which case
      // there is nothing left to say and the socket is simply closed.
      //
      // Not passed to telemetry.recordRequest: when matchRoute is what threw
      // (a malformed req.url, say), there is no route template to attribute
      // the miss to. Inventing one, or minting an unbounded label from the
      // raw path, would corrupt the per-route series this project's SLI is
      // keyed on -- worse than an unrecorded 500. Logged instead, below, so
      // the failure is at least visible and greppable.
      console.error(JSON.stringify({
        msg: 'request-guard',
        method: req.method,
        path: req.url,
        error: err?.message ?? String(err),
      }));
      if (!res.headersSent) {
        try { send(res, 500, { error: 'internal' }); } catch { res.destroy(); }
      } else if (!res.writableEnded) {
        // Headers are out but the body never finished: genuinely
        // unrecoverable, so the half-written response is aborted.
        res.destroy();
      }
      // else: headers were sent AND the response already ended (the
      // realistic trigger is recordRequest throwing after send()) -- the
      // client already has the full response. Destroying here would risk
      // truncating bytes still buffered and kills a keep-alive connection
      // the load generator may be reusing, which shows up as a client-side
      // error the service never actually caused. Leave the socket alone.
    }
  });
}

export async function main() {
  const config = loadConfig();

  // `telemetry` is referenced by onWait before it is assigned, which is safe
  // because onWait only fires on a checkout and the first checkout is warm()
  // below, after the assignment. The optional call covers the ordering anyway.
  let telemetry;
  const { pool, warm, stats, close } = createPool({
    config,
    onWait: (w) => telemetry?.recordPoolWait(w),
  });

  telemetry = startTelemetry({ config, poolStats: stats });

  const prisma = createPrisma(pool);
  const repo = createRepo({ prisma, config });
  const handlers = createHandlers({ repo, config });

  // Same gate as OTel: no METRICS_NAMESPACE, no publisher and no AWS client.
  // Started before the listener so the first overload is already being sampled.
  const metrics = config.metricsNamespace ? startEluPublisher(config) : null;

  // D4: migrations run at container start, behind a flag. Prisma Migrate takes
  // a Postgres advisory lock, so a rolling deploy does not race itself -- which
  // is why this is safe to do on every task rather than in a one-off job that
  // would need a NAT gateway to reach the VPC.
  if (config.migrateOnBoot) {
    const { execFileSync } = await import('node:child_process');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit' });
  }

  // SEED_ON_BOOT IS ONE TASK, ONE SHOT. The advisory-lock argument above is
  // about migrate deploy and does NOT extend to here: seedAll is not
  // idempotent. `posts` has no unique constraint beyond its autoincrement
  // primary key, so `skipDuplicates` on post.createMany can never match --
  // two tasks booting with this flag insert the rows twice, and a redeploy
  // with the flag still set doubles the table again. Since the later plan runs
  // four tasks, and a load profile is only comparable to itself, set
  // SEED_ON_BOOT=1 for a single task on a fresh database and unset it again
  // before scaling out or redeploying.
  if (config.seedOnBoot) {
    const { seedAll } = await import('../prisma/seed.js');
    await seedAll(prisma, { rows: config.seedRows, feeds: config.seedFeeds });
  }

  // Open every connection BEFORE listening, so no measured request pays for
  // TCP + TLS + auth and records it as pool wait (spec 4.2).
  await warm();

  const server = createServer({ handlers, telemetry, config });

  // The ALB's idle_timeout is 60s (terraform/alb.tf). AWS requires the target's keep-alive to
  // exceed the load balancer's idle timeout, or the ALB can dispatch a request onto a connection
  // Node is simultaneously closing, which surfaces as a 502 that burns error budget the service
  // never actually spent. Node's own default (5s) is far under 60s — do not remove these without
  // also raising the ALB's idle_timeout to stay below them.
  server.keepAliveTimeout = 65_000;   // must exceed the ALB's idle_timeout (60s)
  server.headersTimeout   = 66_000;   // must exceed keepAliveTimeout

  server.listen(config.port, () => console.log(`listening on ${config.port}, pool max ${config.poolMax}`));

  const stop = async () => {
    server.close();
    await telemetry.shutdown();   // flush: an unflushed interval is a hole in the window
    await prisma.$disconnect();
    await close();
    metrics?.stop();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
