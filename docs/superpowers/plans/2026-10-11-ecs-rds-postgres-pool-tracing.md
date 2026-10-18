# ecs-rds-postgres-pool tracing (phase 1) Implementation Plan

Status: complete — Tasks 1–9 and 11 executed; **Task 10 (tracing overhead, ratio 1 vs 0) deliberately not run**, by the user's decision on 2026-10-12. Branch `feat/ecs-rds-postgres-pool-tracing` squash-merged to master as `270be10`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every request the `ecs-rds-postgres-pool` service handles produces a trace in Grafana Cloud Tempo showing the route, the pool-connection wait and the exact SQL statement with its duration.

**Architecture:** OpenTelemetry auto-instrumentation (`instrumentation-http`, `instrumentation-pg`) loaded by a `--import` preload so it runs before `node:http` and `pg` are imported; spans go OTLP/HTTP to the existing Alloy gateway collector, which forwards them to Grafana Cloud with the credentials it already holds. Sampling ratio is an env knob wired from Terraform.

**Tech Stack:** Node 22 ESM, `@opentelemetry/sdk-trace-node`, `import-in-the-middle`, Prisma 7 + `@prisma/adapter-pg`, Terraform (AWS + Grafana), Alloy.

**Spec:** `docs/superpowers/specs/2026-10-11-ecs-rds-postgres-pool-tracing-design.md` — read it first; it records the verified spike (which spans appear, and which do not) and the rejected alternatives.

## Global Constraints

- Scope is `ecs-rds-postgres-pool/` only. Never touch `ecs-dynamodb-rps/`.
- Sink is Grafana Cloud Tempo through the existing service → Alloy → Grafana Cloud path. No X-Ray, no new AWS service, no new IAM.
- Instrumentation is auto-instrumentation only. **No manual spans** — that is phase 2 and has its own spec.
- `TRACE_SAMPLE_RATIO` defaults to `1`; valid range `0..1`; out-of-range or non-numeric fails the boot loudly.
- With `OTLP_ENDPOINT` unset, tracing is a complete no-op (no loader hook, no exporter): `npm test` and local runs need no collector.
- `enhancedDatabaseReporting` stays off (parameter values include 1 KB `body` strings). `/healthz` is not traced. Outgoing http is not traced.
- `terraform apply` and `destroy` are their own task and stop for approval. No script may run apply.
- Terraform does not rebuild the image: any change under `service/` needs `./scripts/deploy-service.sh`.
- Every commit follows Conventional Commits (scope `ecs-rds-postgres-pool`, or `ecs-rds-postgres-pool/terraform` for HCL) and ends with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- **The working tree already has uncommitted changes that are not this plan's:** `infra/main/ecs.tf` (`wait_for_steady_state`), `infra/main/dev.tfvars` (`pool_size`, `task_cpu`, `task_memory`), `service/src/pool.js` (warm batching), `infra/grafana/dashboard.json.tftpl`. Stage only this plan's hunks (`git add -p`); never `git add -A` or `git commit -a`.
- Versions are pinned exactly as spiked: `@opentelemetry/sdk-trace-node@2.12.0`, `@opentelemetry/exporter-trace-otlp-http@0.223.0`, `@opentelemetry/instrumentation-http@0.223.0`, `@opentelemetry/instrumentation-pg@0.75.0`, `@opentelemetry/instrumentation@0.223.0`, `import-in-the-middle@3.5.2`.

## Review Focus

Failure modes the spec implies that no happy-path task would catch, most likely first. Each has a test in the task named.

1. **`OTLP_ENDPOINT` unset must not change behaviour** (tests, a local run, the seed script): the preload registers nothing and exits cleanly. — Task 4.
2. **The collector being unreachable must not crash or slow the service**: the exporter drops spans; the process keeps running. — Task 4.
3. **A request for an unknown route (404) or a malformed URL must not throw out of the request hook**; the hook is on every request's path. — Task 4.
4. **`TRACE_SAMPLE_RATIO=1.5`, `-1`, `abc` must fail boot by name**, not silently trace 100% or 0%. — Task 2.
5. **SQL parameter values must never reach a span.** — Task 4 asserts `enhancedDatabaseReporting` is false in the options the preload hands to the pg instrumentation.

---

### Task 1: Dependencies

**Files:**
- Modify: `ecs-rds-postgres-pool/service/package.json`, `ecs-rds-postgres-pool/service/package-lock.json`

**Interfaces:**
- Produces: the packages named in Global Constraints, importable from `service/src/`.

- [ ] **Step 1: Install exact versions**

```bash
cd ecs-rds-postgres-pool/service
npm install --save-exact \
  @opentelemetry/sdk-trace-node@2.12.0 \
  @opentelemetry/exporter-trace-otlp-http@0.223.0 \
  @opentelemetry/instrumentation-http@0.223.0 \
  @opentelemetry/instrumentation-pg@0.75.0 \
  @opentelemetry/instrumentation@0.223.0 \
  import-in-the-middle@3.5.2
```

- [ ] **Step 2: Check for duplicate copies of the shared packages**

Run: `npm ls @opentelemetry/instrumentation @opentelemetry/resources @opentelemetry/core @opentelemetry/api`
Expected: one resolved version of `@opentelemetry/api` (1.9.1). If `@opentelemetry/resources` or `@opentelemetry/instrumentation` shows two versions, align them by bumping `@opentelemetry/resources`, `@opentelemetry/sdk-metrics` (both `2.10.0`) to `2.12.0` with `npm install --save-exact`, and re-run. Duplicates are tolerated only if Step 3 passes.

- [ ] **Step 3: Existing suite still green**

Run: `npm test`
Expected: all existing tests PASS (the metrics path in `otel.js` is untouched).

- [ ] **Step 4: Commit**

```bash
git add ecs-rds-postgres-pool/service/package.json ecs-rds-postgres-pool/service/package-lock.json
git commit -m "build(ecs-rds-postgres-pool): add otel trace sdk and http/pg instrumentation" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The `TRACE_SAMPLE_RATIO` knob in the service config

**Files:**
- Modify: `ecs-rds-postgres-pool/service/src/config.js`
- Test: `ecs-rds-postgres-pool/service/test/config.test.js`

**Interfaces:**
- Produces: `loadConfig(env).traceSampleRatio` — a number in `[0, 1]`, default `1`.

- [ ] **Step 1: Write the failing tests** (append to `config.test.js`)

```js
test('TRACE_SAMPLE_RATIO defaults to 1 and treats empty as absent', () => {
  assert.equal(loadConfig(base).traceSampleRatio, 1);
  assert.equal(loadConfig({ ...base, TRACE_SAMPLE_RATIO: '' }).traceSampleRatio, 1);
});

test('TRACE_SAMPLE_RATIO is read as a fraction', () => {
  assert.equal(loadConfig({ ...base, TRACE_SAMPLE_RATIO: '0.25' }).traceSampleRatio, 0.25);
  assert.equal(loadConfig({ ...base, TRACE_SAMPLE_RATIO: '0' }).traceSampleRatio, 0);
});

test('TRACE_SAMPLE_RATIO outside 0..1 or non-numeric fails the boot by name', () => {
  for (const bad of ['1.5', '-1', 'abc']) {
    assert.throws(() => loadConfig({ ...base, TRACE_SAMPLE_RATIO: bad }), /TRACE_SAMPLE_RATIO/, bad);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ecs-rds-postgres-pool/service && node --test test/config.test.js`
Expected: FAIL — `traceSampleRatio` is `undefined` (default test) and `1.5` does not throw.

- [ ] **Step 3: Implement** — in `config.js`, add the helper after `num` and the field after `exportIntervalMs`:

```js
// A fraction: num() already rejects negatives and non-numbers; this adds the ceiling.
function ratio(env, key, dflt) {
  const n = num(env, key, dflt);
  if (n > 1) throw new Error(`${key} must be between 0 and 1, got ${JSON.stringify(env[key])}`);
  return n;
}
```

```js
    // Fraction of requests traced. 1 = every request (a deliberate choice: the
    // slow ones are the point). Lower it with the Terraform knob, not by editing code.
    traceSampleRatio: ratio(env, 'TRACE_SAMPLE_RATIO', 1),
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ecs-rds-postgres-pool/service/src/config.js ecs-rds-postgres-pool/service/test/config.test.js
git commit -m "feat(ecs-rds-postgres-pool): add trace sample ratio to service config" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Extract the route table so the tracing preload can use it

**Why:** the preload must not import `handlers.js` — that pulls in `db.js`, Prisma and `pg` *before* the instrumentation is registered, which would leave `pg` unpatched. `matchRoute` and `ROUTE_CLASS` are the single source of truth; this moves them into an import-free module and re-exports them, so nothing else changes.

**Files:**
- Create: `ecs-rds-postgres-pool/service/src/routes.js`
- Modify: `ecs-rds-postgres-pool/service/src/handlers.js` (remove `ROUTES`, `ROUTE_CLASS`, `matchRoute`; re-export)
- Test: `ecs-rds-postgres-pool/service/test/routes.test.js`

**Interfaces:**
- Produces: `routes.js` exports `ROUTE_CLASS: Record<string,string>` and `matchRoute(method: string, path: string): { name, params, template } | null` — identical behaviour to today's. `handlers.js` keeps exporting both names.

- [ ] **Step 1: Write the failing test** `test/routes.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchRoute, ROUTE_CLASS } from '../src/routes.js';
import * as handlers from '../src/handlers.js';

test('matchRoute returns name, params and the template, not the raw path', () => {
  assert.deepEqual(matchRoute('GET', '/posts/7'), { name: 'getPost', params: { id: '7' }, template: '/posts/:id' });
  assert.deepEqual(matchRoute('POST', '/reports'), { name: 'report', params: {}, template: '/reports' });
});

test('an unknown route or wrong method is null', () => {
  assert.equal(matchRoute('GET', '/nope'), null);
  assert.equal(matchRoute('DELETE', '/posts/7'), null);
});

test('handlers.js re-exports the same table, so there is one source of truth', () => {
  assert.equal(handlers.matchRoute, matchRoute);
  assert.equal(handlers.ROUTE_CLASS, ROUTE_CLASS);
});

test('/healthz carries no class', () => {
  assert.equal(ROUTE_CLASS.health, undefined);
});

test('routes.js imports nothing, so the tracing preload can load it before pg', () => {
  const src = readFileSync(new URL('../src/routes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/routes.test.js`
Expected: FAIL — `Cannot find module '../src/routes.js'`.

- [ ] **Step 3: Implement**

Create `src/routes.js` containing the `ROUTES` array, `ROUTE_CLASS` (with its existing comment) and `matchRoute`, moved verbatim from `handlers.js` (lines for `const ROUTES = [...]`, `export const ROUTE_CLASS = {...}`, `export function matchRoute(...)`), with `export` on `ROUTE_CLASS` and `matchRoute` and **no import statements**.

In `handlers.js`, delete those three blocks and add, below the existing `import { buildPost } from './db.js';`:

```js
import { matchRoute, ROUTE_CLASS } from './routes.js';

// Kept as exports: server.js, scripts/generate-slo.js and the tests import them from here.
export { matchRoute, ROUTE_CLASS };
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS, including `handlers.test.js`, `server.test.js` and `generate-slo.test.js` (they assert the class map against `slo.yaml`).

- [ ] **Step 5: Commit**

```bash
git add ecs-rds-postgres-pool/service/src/routes.js ecs-rds-postgres-pool/service/src/handlers.js ecs-rds-postgres-pool/service/test/routes.test.js
git commit -m "refactor(ecs-rds-postgres-pool): move route table to an import-free module" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Tracing options and the preload

**Files:**
- Create: `ecs-rds-postgres-pool/service/src/tracing-options.js`, `ecs-rds-postgres-pool/service/src/tracing.js`
- Test: `ecs-rds-postgres-pool/service/test/tracing.test.js`

**Interfaces:**
- Consumes: `matchRoute`, `ROUTE_CLASS` from `./routes.js`; `loadConfig` (Task 2); `buildResource(config)` from `./otel.js` (async, returns an OTel `Resource`).
- Produces from `tracing-options.js`:
  - `ignoreIncoming(req): boolean` — true for `/healthz`.
  - `serverRequestHook(span, req): void` — names the span `"<METHOD> <template>"` and sets `http.route` and `class`.
  - `httpOptions(): object` — options for `HttpInstrumentation`.
  - `pgOptions: { enhancedDatabaseReporting: false }`.
  - `BATCH: { maxQueueSize, maxExportBatchSize, scheduledDelayMillis }`.
- `tracing.js` is a side-effect module, loaded as `node --import ./src/tracing.js src/server.js`.

- [ ] **Step 1: Write the failing tests** `test/tracing.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ignoreIncoming, serverRequestHook, httpOptions, pgOptions, BATCH } from '../src/tracing-options.js';

const fakeSpan = () => {
  const s = { name: null, attrs: {} };
  s.updateName = (n) => { s.name = n; };
  s.setAttribute = (k, v) => { s.attrs[k] = v; };
  return s;
};

test('the request hook names the span and sets route and class', () => {
  const s = fakeSpan();
  serverRequestHook(s, { method: 'POST', url: '/reports' });
  assert.equal(s.name, 'POST /reports');
  assert.deepEqual(s.attrs, { 'http.route': '/reports', class: 'heavy' });
});

test('the template, not the concrete id, is what is recorded', () => {
  const s = fakeSpan();
  serverRequestHook(s, { method: 'GET', url: '/posts/123?x=1' });
  assert.equal(s.attrs['http.route'], '/posts/:id');
  assert.equal(s.attrs.class, 'fast');
});

test('an unknown route, a missing url or a client request never throws', () => {
  for (const req of [{ method: 'GET', url: '/nope' }, { method: 'GET' }, {}, { method: 'GET', url: 42 }]) {
    const s = fakeSpan();
    assert.doesNotThrow(() => serverRequestHook(s, req));
    assert.deepEqual(s.attrs, {});
  }
});

test('/healthz is ignored, with or without a query string; real routes are not', () => {
  assert.equal(ignoreIncoming({ url: '/healthz' }), true);
  assert.equal(ignoreIncoming({ url: '/healthz?x=1' }), true);
  assert.equal(ignoreIncoming({ url: '/posts/1' }), false);
});

test('outgoing http is never traced', () => {
  assert.equal(httpOptions().ignoreOutgoingRequestHook(), true);
});

test('SQL parameter values are never recorded', () => {
  assert.equal(pgOptions.enhancedDatabaseReporting, false);
});

test('the batch queue is sized for 100% sampling under load', () => {
  assert.ok(BATCH.maxQueueSize >= 8192);
});

const preload = fileURLToPath(new URL('../src/tracing.js', import.meta.url));
const run = (env) => spawnSync(process.execPath, ['--import', preload, '-e', 'setTimeout(() => {}, 300)'], {
  env: { PATH: process.env.PATH, DATABASE_URL: 'postgresql://u:p@localhost:5432/d', ...env },
  encoding: 'utf8',
  timeout: 20_000,
});

test('with OTLP_ENDPOINT unset the preload is a clean no-op', () => {
  const r = run({});
  assert.equal(r.status, 0, r.stderr);
});

test('an unreachable collector does not crash the process', () => {
  const r = run({ OTLP_ENDPOINT: 'http://127.0.0.1:1' });
  assert.equal(r.status, 0, r.stderr);
});

test('a bad TRACE_SAMPLE_RATIO fails the boot by name', () => {
  const r = run({ OTLP_ENDPOINT: 'http://127.0.0.1:1', TRACE_SAMPLE_RATIO: '2' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TRACE_SAMPLE_RATIO/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/tracing.test.js`
Expected: FAIL — `Cannot find module '../src/tracing-options.js'`.

- [ ] **Step 3: Implement `src/tracing-options.js`**

```js
// src/tracing-options.js
// The decisions the tracing preload makes, kept apart from the preload so they
// can be tested without a loader hook or a collector. Imports only routes.js,
// which imports nothing: the preload must not pull pg in before the
// instrumentation is registered.
import { matchRoute, ROUTE_CLASS } from './routes.js';

/**
 * 100% sampling at hundreds of rps is thousands of spans a second; the SDK
 * default queue (2048) would drop silently. Sized for it, flushed every second.
 */
export const BATCH = { maxQueueSize: 8192, maxExportBatchSize: 1024, scheduledDelayMillis: 1000 };

const pathOf = (req) => (typeof req?.url === 'string' ? req.url.split('?')[0] : null);

/** ALB health checks are not requests anyone debugs, and would dominate idle volume. */
export function ignoreIncoming(req) {
  return pathOf(req) === '/healthz';
}

/**
 * The auto-instrumented server span is named just "GET" and carries the raw
 * path. This gives it the route TEMPLATE (never the concrete id) and the SLO
 * class, so TraceQL can filter by class. Runs on every request: it must not throw.
 */
export function serverRequestHook(span, req) {
  const path = pathOf(req);
  if (path === null || typeof req.method !== 'string') return;
  const route = matchRoute(req.method, path);
  if (!route) return;
  span.updateName(`${req.method} ${route.template}`);
  span.setAttribute('http.route', route.template);
  const cls = ROUTE_CLASS[route.name];
  if (cls) span.setAttribute('class', cls);
}

export function httpOptions() {
  return {
    ignoreIncomingRequestHook: ignoreIncoming,
    // The OTLP exporter and the CloudWatch publisher would otherwise show up as
    // client spans every few seconds.
    ignoreOutgoingRequestHook: () => true,
    requestHook: serverRequestHook,
  };
}

// Explicit rather than default: with it on, every span would carry the bound
// parameter values, including 1 KB post bodies. Statement text only.
export const pgOptions = { enhancedDatabaseReporting: false };
```

- [ ] **Step 4: Implement `src/tracing.js`**

```js
// src/tracing.js
// Loaded with `node --import ./src/tracing.js src/server.js`. It has to run
// BEFORE server.js imports node:http and pg, which is why it is a preload and
// not part of startTelemetry (called from main(), after those imports).
//
// Order below is load-bearing: the loader hook, then the instrumentations, and
// only then anything that might import http or pg (otel.js's exporter does).
//
// With OTLP_ENDPOINT unset this does nothing at all -- no hook, no exporter --
// so tests and local runs need no collector.
import { register } from 'node:module';

if (process.env.OTLP_ENDPOINT) {
  register('import-in-the-middle/hook.mjs', import.meta.url);

  const { NodeTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } =
    await import('@opentelemetry/sdk-trace-node');
  const { registerInstrumentations } = await import('@opentelemetry/instrumentation');
  const { HttpInstrumentation } = await import('@opentelemetry/instrumentation-http');
  const { PgInstrumentation } = await import('@opentelemetry/instrumentation-pg');
  const { BATCH, httpOptions, pgOptions } = await import('./tracing-options.js');

  registerInstrumentations({
    instrumentations: [new HttpInstrumentation(httpOptions()), new PgInstrumentation(pgOptions)],
  });

  // Safe to import now that the instrumentations are registered.
  const { loadConfig } = await import('./config.js');
  const { buildResource } = await import('./otel.js');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');

  const config = loadConfig();
  const provider = new NodeTracerProvider({
    // The same resource as the metrics, so a trace and its series share service.instance.id.
    resource: await buildResource(config),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.traceSampleRatio) }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${config.otlpEndpoint}/v1/traces` }), BATCH),
    ],
  });
  provider.register();

  // ECS sends SIGTERM on stop; flush what is queued. Additional listener only:
  // server.js's own shutdown is unaffected.
  process.once('SIGTERM', () => { provider.shutdown().catch(() => {}); });
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/tracing.test.js && npm test`
Expected: PASS, whole suite green. (`buildResource` contacts the ECS metadata endpoint only when `ECS_CONTAINER_METADATA_URI_V4` is set; locally it falls back to `local-<pid>`.)

- [ ] **Step 6: Commit**

```bash
git add ecs-rds-postgres-pool/service/src/tracing-options.js ecs-rds-postgres-pool/service/src/tracing.js ecs-rds-postgres-pool/service/test/tracing.test.js
git commit -m "feat(ecs-rds-postgres-pool): add tracing preload with http and pg auto-instrumentation" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Dockerfile and a local end-to-end check (Node 22 image, Prisma path)

This task closes spec risks 1 and 2: the spike used raw `pg` on Node 24; this proves the real image, Node 22 and Prisma `$queryRaw`.

**Files:**
- Modify: `ecs-rds-postgres-pool/service/Dockerfile` (the final `CMD`)
- Scratch (not committed): a stub OTLP receiver in a `mktemp -d` directory

- [ ] **Step 1: Change the CMD**

```dockerfile
CMD ["node", "--import", "./src/tracing.js", "src/server.js"]
```

- [ ] **Step 2: Create the stub receiver outside the repo**

```bash
D=$(mktemp -d) && echo "$D"
cat > "$D/otlp-stub.mjs" <<'E'
import http from 'node:http';
http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    if (req.url === '/v1/traces') {
      try {
        for (const rs of JSON.parse(b).resourceSpans ?? [])
          for (const ss of rs.scopeSpans ?? [])
            for (const s of ss.spans ?? []) {
              const a = Object.fromEntries((s.attributes ?? []).map((x) => [x.key, Object.values(x.value)[0]]));
              console.log(JSON.stringify({
                name: s.name,
                ms: Math.round((Number(s.endTimeUnixNano) - Number(s.startTimeUnixNano)) / 1e6),
                route: a['http.route'], class: a.class,
                sql: String(a['db.statement'] ?? a['db.query.text'] ?? '').slice(0, 70),
              }));
            }
      } catch (e) { console.log('unparsable', e.message); }
    }
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
}).listen(4318, () => console.log('stub on 4318'));
E
node "$D/otlp-stub.mjs" > "$D/spans.log" 2>&1 &
```

- [ ] **Step 3: Start Postgres and the built image**

```bash
docker network create trace-smoke 2>/dev/null
docker run -d --rm --name trace-pg --network trace-smoke -e POSTGRES_PASSWORD=pw postgres:16
docker build -t rds-pool-trace ecs-rds-postgres-pool/service
docker run -d --rm --name trace-app --network trace-smoke -p 8080:8080 \
  -e DATABASE_URL=postgresql://postgres:pw@trace-pg:5432/postgres -e DB_SSL=off \
  -e MIGRATE_ON_BOOT=1 -e SEED_ON_BOOT=1 -e SEED_ROWS=2000 -e SEED_FEEDS=4 \
  -e REPORT_SCAN_ROWS=1000 -e REPORT_SLEEP_MS=50 \
  -e OTLP_ENDPOINT=http://host.docker.internal:4318 rds-pool-trace
until curl -fsS localhost:8080/healthz; do sleep 2; done
```
Expected: `{"ok":true}` within about a minute (migrate + seed run at boot). If the container exits, `docker logs trace-app` — a loader-hook failure on Node 22 shows here and is the thing this task exists to find.

- [ ] **Step 4: Exercise the three route classes**

```bash
curl -fsS localhost:8080/posts/5 >/dev/null
curl -fsS localhost:8080/feeds/2/posts >/dev/null
curl -fsS -X POST localhost:8080/reports -H 'content-type: application/json' -d '{"feedId":2}' >/dev/null
sleep 3; cat "$D/spans.log"
```
Expected, in `spans.log`: for each request a server span named `GET /posts/:id` / `GET /feeds/:id/posts` / `POST /reports` with `class` `fast` / `standard` / `heavy`; a `pg-pool.connect` child; a `pg.query:…` child whose `sql` is the statement text, and for `/reports` the text starts `WITH scanned AS`. **No span for `/healthz`** even though the container's own health polling ran.

- [ ] **Step 5: Record the outcome, then clean up**

If any expected span is missing (most likely: no `pg.query` spans under Prisma), stop and report it — do not continue to Task 6; the spec's premise needs revisiting. Otherwise:

```bash
docker rm -f trace-app trace-pg; docker network rm trace-smoke; kill %1
```

- [ ] **Step 6: Commit**

```bash
git add ecs-rds-postgres-pool/service/Dockerfile
git commit -m "feat(ecs-rds-postgres-pool): start the service with the tracing preload" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Terraform knob, collector traces pipeline, token-scope docs

**Files:**
- Modify: `ecs-rds-postgres-pool/infra/main/variables.tf`, `infra/main/dev.tfvars`, `infra/main/ecs.tf`, `infra/main/outputs.tf`, `infra/grafana/alloy.alloy.tftpl`, `../.env.example`

**Interfaces:**
- Produces: variable `trace_sample_ratio` (number, default 1); container env `TRACE_SAMPLE_RATIO`; `knobs.trace_sample_ratio`.

- [ ] **Step 1: Variable** — append to `variables.tf` after `pool_connection_timeout_ms`:

```hcl
variable "trace_sample_ratio" {
  description = "Fraction of requests traced, 0..1. 1 = every request, the default, chosen deliberately: slow requests are the point. Tracing runs inside the task under test, so it is part of the configuration being measured -- hold it constant across runs being compared; it is recorded in the knobs output."
  type        = number
  default     = 1

  validation {
    condition     = var.trace_sample_ratio >= 0 && var.trace_sample_ratio <= 1
    error_message = "trace_sample_ratio must be between 0 and 1."
  }
}
```

Also change the `grafana_otlp_password` description to: `"Grafana Cloud access policy token. Needs the metrics:write AND traces:write scopes (traces:write added 2026-10-11 for service tracing)."`

- [ ] **Step 2: tfvars** — add under the knob block in `dev.tfvars`:

```hcl
# --- tracing ---
trace_sample_ratio = 1 # 1 = every request. Hold constant across runs being compared.
```

- [ ] **Step 3: Container env** — in `ecs.tf`, directly after the `OTLP_ENDPOINT` line:

```hcl
    { name = "TRACE_SAMPLE_RATIO", value = tostring(var.trace_sample_ratio) },
```

- [ ] **Step 4: Knobs output** — in `outputs.tf`'s `knobs` map add `trace_sample_ratio = var.trace_sample_ratio`.

- [ ] **Step 5: Collector** — in `alloy.alloy.tftpl` replace the receiver's `output` and the batch processor's `output`, and update the section header comment to `Pipeline 1: service metrics and traces`:

```
  output {
    metrics = [otelcol.processor.transform.classify.input]
    traces  = [otelcol.processor.batch.default.input]
  }
```
```
otelcol.processor.batch "default" {
  output {
    metrics = [otelcol.exporter.otlphttp.grafana_cloud.input]
    traces  = [otelcol.exporter.otlphttp.grafana_cloud.input]
  }
}
```
The `transform "classify"` block stays metrics-only.

- [ ] **Step 6: `.env.example`** — in the OTLP gateway comment block change `Scope it to metrics:write ONLY` to `Scope it to metrics:write and traces:write ONLY`, and `appends /v1/metrics itself` to `appends /v1/metrics and /v1/traces itself`.

- [ ] **Step 7: Verify the HCL**

Run (from `ecs-rds-postgres-pool/`):
```bash
terraform -chdir=infra/main fmt -check && terraform -chdir=infra/main validate
direnv exec ../ terraform -chdir=infra/main plan -var-file=dev.tfvars -out=/dev/null 2>&1 | tail -40
```
Expected: fmt and validate clean. The plan shows, from this task: the app task definition changing (new `TRACE_SAMPLE_RATIO`), the collector task definition changing (new config), and the service replacements that follow. **If the plan also shows `POOL_MAX`, `cpu` or `memory` changing, that is the unrelated uncommitted `dev.tfvars` work (deployed `POOL_MAX` is 50; the file says 2) — do not proceed; report it and let the user decide.** This step is plan only.

- [ ] **Step 8: Validate the Alloy config**

```bash
IMG=$(grep -A3 'variable "alloy_image"' ecs-rds-postgres-pool/infra/main/variables.tf | grep -o 'grafana/alloy:[^"]*' | head -1)
C=$(mktemp -d)
sed -e 's/\${class_statements}//' ecs-rds-postgres-pool/infra/grafana/alloy.alloy.tftpl > "$C/c.alloy"
docker run --rm -v "$C:/cfg" "$IMG" validate --stability.level=experimental /cfg/c.alloy
```
Expected: exit 0. If `validate` is not a subcommand of that Alloy version, use `fmt /cfg/c.alloy` and expect it to parse without error; note which was used.

- [ ] **Step 9: Commit** (stage only this task's hunks in `ecs.tf` and `dev.tfvars`)

```bash
git add -p ecs-rds-postgres-pool/infra/main/ecs.tf ecs-rds-postgres-pool/infra/main/dev.tfvars
git add ecs-rds-postgres-pool/infra/main/variables.tf ecs-rds-postgres-pool/infra/main/outputs.tf ecs-rds-postgres-pool/infra/grafana/alloy.alloy.tftpl .env.example
git commit -m "feat(ecs-rds-postgres-pool/terraform): wire trace sampling knob and collector traces pipeline" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: README — env contract, where to look, reading a trace

**Files:**
- Modify: `ecs-rds-postgres-pool/README.md`

- [ ] **Step 1: Environment-variable table** — add after the `OTLP_ENDPOINT` row:

```
| `TRACE_SAMPLE_RATIO` | number 0..1 | 1 (every request); out of range fails the boot | `trace_sample_ratio` |
```

- [ ] **Step 2: Where-to-look table** — add a row:

```
| `https://k0valchuk.grafana.net/explore` | data source **grafanacloud-traces** (Tempo) → query type TraceQL; see [Reading a trace](#reading-a-trace) |
```

- [ ] **Step 3: Add a section after "3. What is the bottleneck?"**

```markdown
## Reading a trace

Every request except `/healthz` is traced at `trace_sample_ratio` (default 1). Each trace is one server
span named `<METHOD> <route template>` carrying `class`, with these children:

| span | means |
|---|---|
| `pg-pool.connect` | time waiting for a pool connection — the pool queue, for this one request |
| `pg.connect` | a *new* connection being opened (TCP + TLS + auth); absent when the pool reused one |
| `pg.query:…` | one SQL statement; `db.statement` is its text with `$1` placeholders, never the values |

Gaps between children are Prisma's in-process work or event-loop delay — there is no span for them yet
(manual spans are a planned second phase). In Explore, with the Tempo data source:

- slow requests: `{ resource.service.name = "ecs-rds-postgres-pool" && duration > 1s }`
- slow heavy-class requests: `{ resource.service.name = "ecs-rds-postgres-pool" && span.class = "heavy" && duration > 500ms }`
- the pool queue alone: `{ name = "pg-pool.connect" && duration > 100ms }`
- one statement: `{ span.db.statement =~ ".*WITH scanned.*" }`

Tracing runs inside the task under test, so `trace_sample_ratio` is part of the configuration: it is in
the `knobs` output and must be the same across runs you compare.
```

- [ ] **Step 4: Replace the stale credentials sentence** — where the README or `.env.example` references the OTLP token scope as metrics-only, update it to name both scopes (search: `grep -n "metrics:write" README.md`).

- [ ] **Step 5: Commit**

```bash
git add ecs-rds-postgres-pool/README.md
git commit -m "docs(ecs-rds-postgres-pool): document tracing knob and how to read a trace" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: APPLY — stops for approval

Do not run any step of this task without an explicit yes from the user in chat. It changes billable AWS resources and a shared secret.

- [ ] **Step 1: User adds the `traces:write` scope** to the Grafana Cloud access policy behind `GRAFANA_OTLP_PASSWORD` (Grafana Cloud portal → Access Policies). Because a scope edit on an existing policy leaves the token string unchanged, `.env` needs no edit; if the user instead mints a new token, they update `GRAFANA_OTLP_PASSWORD` in `.env` and run `direnv allow`.

- [ ] **Step 2 (only if a new token was minted): re-apply the shared stack** so remote runs receive it

Run: `terraform -chdir=platform plan` and show the diff to the user; **approval gate**, then `terraform -chdir=platform apply`.

- [ ] **Step 3: Plan the project and show it**

Run: `terraform -chdir=ecs-rds-postgres-pool/infra/main plan -var-file=dev.tfvars`
Expected diff: app task definition (adds `TRACE_SAMPLE_RATIO`), collector task definition, service updates. Anything else — especially `POOL_MAX`, `cpu`, `memory` — is the unrelated `dev.tfvars` drift: stop and ask.

- [ ] **Step 4: Apply — approval gate**

Run: `terraform -chdir=ecs-rds-postgres-pool/infra/main apply -var-file=dev.tfvars`
Expected: success; `wait_for_steady_state` is on in the working tree, so a rolled-back deployment fails the apply instead of passing silently.

- [ ] **Step 5: Build and roll the image** (Terraform does not rebuild it)

Run: `cd ecs-rds-postgres-pool && ./scripts/deploy-service.sh`
Expected: build amd64 → push → force new deployment → health OK. A slower first start than before is the loader hook (spec risk 5); only a failed health wait is a problem.

- [ ] **Step 6: Check the knob landed**

Run: `terraform -chdir=ecs-rds-postgres-pool/infra/main output -json knobs | jq .trace_sample_ratio`
Expected: `1`.

---

### Task 9: Verify in Tempo — the success criteria

- [ ] **Step 1: Generate one of each class**

```bash
BASE=$(terraform -chdir=ecs-rds-postgres-pool/infra/main output -json | jq -r '.base_url.value')
curl -fsS "$BASE/posts/5" >/dev/null
curl -fsS "$BASE/feeds/2/posts" >/dev/null
curl -fsS -X POST "$BASE/reports" -H 'content-type: application/json' -d '{"feedId":2}' >/dev/null
```

- [ ] **Step 2: Find the traces** — in Grafana Explore (data source `grafanacloud-traces`), run `{ resource.service.name = "ecs-rds-postgres-pool" && span.class = "heavy" }`, open the newest trace.
Expected: `POST /reports` root; a `pg-pool.connect` child; a `pg.query` child whose `db.statement` begins `WITH scanned AS` with a duration of at least `report_sleep_ms` (320 ms). Repeat for `standard` (feed statement) and `fast` (post select).

- [ ] **Step 3: Confirm the noise cuts** — `{ resource.service.name = "ecs-rds-postgres-pool" && name =~ ".*healthz.*" }` returns nothing.

- [ ] **Step 4: Confirm the instance id joins the metrics** — the trace resource's `service.instance.id` equals the `instance` label on the dashboard's pool-wait series for the same task.

If a trace is missing or unparsable, check the collector log group `/ecs/ecs-rds-postgres-pool-collector` for a 401/403 from Grafana (token scope) before suspecting code.

---

### Task 10: Measure the cost of tracing (spec risk 3) — two approval gates

The deliverable of this repo is a measured before/after; the instrument gets measured too. Compare the **same** k6 profile and rate with `trace_sample_ratio = 1` and `0`. (`0` still pays the loader hook; this isolates sampling and export cost, which is the part the knob controls.)

- [ ] **Step 1: Run at ratio 1** — upload and run the constant profile at a rate known to be healthy (run 8787587's first step held 100 rps with p50 4.9 ms and 99.7% SLO met; use `RATE=100`):

```bash
cd ecs-rds-postgres-pool
./scripts/upload-k6.sh --rate 100
```
Then run `constant` from the k6 projects page (or `k6 cloud run -e RATE=100 infra/k6/tests/constant.js`), and record with `/loadtest ecs-rds-postgres-pool constant` so the row carries the `knobs` output (`trace_sample_ratio = 1`). Also record ECS `CPUUtilization` Max over the run window from CloudWatch.

- [ ] **Step 2: Set ratio 0 — approval gate.** Edit `dev.tfvars` `trace_sample_ratio = 0`, show the plan, get a yes, `terraform -chdir=infra/main apply -var-file=dev.tfvars`. The task definition changes, so no image rebuild is needed.

- [ ] **Step 3: Run the identical profile** (`RATE=100`, same scripts, same thresholds — never edit the profile), record with `/loadtest`, record ECS CPU Max.

- [ ] **Step 4: Restore the default — approval gate.** Set `trace_sample_ratio = 1`, plan, apply.

- [ ] **Step 5: Write the comparison** in the README's "Measured results": the two p50/p95 per class and ECS CPU Max, from the two `results.md` rows. Every number must come from those runs — no remembered figures.

- [ ] **Step 6: Commit**

```bash
git add ecs-rds-postgres-pool/results.md ecs-rds-postgres-pool/README.md ecs-rds-postgres-pool/infra/main/dev.tfvars
git commit -m "docs(ecs-rds-postgres-pool): record tracing overhead at ratio 1 vs 0" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(Use `git add -p` for `dev.tfvars`: the file still carries unrelated uncommitted lines.)

---

### Task 11: Close out

- [ ] **Step 1:** Set `Status:` in the spec to `complete` and in this plan to `complete`, listing tasks 1–10 done; if anything stopped early, use `partially executed (on hold)` with the done tasks and the blocker, per the repo rule.
- [ ] **Step 2:** In the spec's "Out of scope", leave the phase-2 pointer: manual inner spans (Prisma operation, read body, handler, summarize, send, event-loop delay) get their own spec, to be written once the first real traces from Task 9 show which gaps matter.
- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-11-ecs-rds-postgres-pool-tracing-design.md docs/superpowers/plans/2026-10-11-ecs-rds-postgres-pool-tracing.md
git commit -m "docs(ecs-rds-postgres-pool): mark tracing phase 1 spec and plan complete" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Ledger (written during execution)

- **Task 1:** also bumped `@opentelemetry/resources`, `sdk-metrics` to 2.12.0 and `exporter-metrics-otlp-http` to 0.223.0 to dedupe `core`/`resources` (the plan's Step 2 path). One `@opentelemetry/instrumentation@0.221.0` copy remains, pulled by `instrumentation-runtime-node@0.34.0`; tests pass with it.
- **Baseline test failures, not caused by this work** (both reproduce with the new dependencies stashed): `a deliberately blocked loop reads close to 1` (ELU timing, fails on this machine) and `vcpu_per_task agrees with the task size Terraform allocates` (slo.yaml says 0.25, the uncommitted `dev.tfvars` has `task_cpu = 512`). Ruling: gate each task on "no new failures"; the second is the user's to resolve with the `task_cpu` change.
- **Task 3:** `Prisma client` had to be regenerated (`npx prisma generate`) after `npm install` — the README's documented first step.
- **Task 5 result (spec risks 1 and 2 closed):** built image on Node 22.13, real Postgres 16, Prisma `$queryRaw`. Server spans named `GET /posts/:id` (fast), `GET /feeds/:id/posts` (standard), `POST /reports` (heavy), each with `pg-pool.connect` and `pg.query` children carrying the statement text; the report statement text starts `WITH scanned AS`. Zero `/healthz` spans. An unknown route yields a bare `GET` span. Boot-time pool warm-up and the seed also emit parentless spans (documented in the README).
- **Task 6:** alloy `validate` exit 0 on `grafana/alloy:v1.10.0` with the traces wiring. `terraform fmt` re-aligned three unrelated lines in `dev.tfvars` and the `knobs` map. Committed against HEAD versions of `ecs.tf`/`dev.tfvars`; the user's uncommitted hunks were restored on top and are untouched.
- **Task 6 plan result:** 2 add / 3 change / 2 destroy: both task definitions replaced, both ECS services updated, plus a benign `aws_db_parameter_group` `rds.force_ssl` apply-method normalisation (pre-existing).
- **Open ruling needed before Task 8:** the plan shows `POOL_MAX "5" -> "2"` (Terraform's recorded value 5 vs the uncommitted `dev.tfvars` `pool_size = 2`), while the live task definition `:16` has `POOL_MAX=50`. Three different values; applying would silently set 2.
- **Task 8 done 2026-10-12:** user ruled `pool_size = 5` (matches AWS); re-plan showed only `TRACE_SAMPLE_RATIO` added plus the benign `rds.force_ssl` apply-method normalisation. Applied (`knobs.trace_sample_ratio = 1`, `pool_size = 5`) and `deploy-service.sh` completed with the service stable and `/healthz` responding.
- **Task 9 blocked (found 2026-10-12):** the collector log shows `Exporting failed. Dropping data … /v1/traces responded with HTTP Status Code 401`. A direct POST with the same credentials: `/v1/traces` → 401 `invalid scope requested`, `/v1/metrics` → 200. SSM `/ecs-rds-postgres-pool/collector/otlp_password` equals the `.env` token, so the collector is using what it was given. The scope the user added is not on the policy that issued this token (or has not taken effect). Not a code defect; the service kept answering 200 throughout, so a failing trace export does not hurt requests.
- **To unblock:** in Grafana Cloud, confirm the access policy that owns the `GRAFANA_OTLP_PASSWORD` token has `traces:write`; if it is a different policy, add the scope there, or mint a new token with `metrics:write` + `traces:write`, put it in `.env` as `GRAFANA_OTLP_PASSWORD`, `direnv allow`, then `terraform -chdir=platform apply` and `terraform -chdir=ecs-rds-postgres-pool/infra/main apply -var-file=dev.tfvars` (approval gates), and force a new deployment of the collector service so it reads the new SSM value.
- **Task 9 done 2026-10-12:** after the user minted a token with `traces:write`, the platform and project applies ran and the collector was force-redeployed (`SSM == .env`, zero `Exporting failed` in the following 2 minutes). Tempo returns three `POST /reports` traces (451/471/452 ms) each with `pg-pool.connect` (0 ms) and `pg.query:WITH …` (450 ms) whose statement text starts `WITH scanned AS`. **Correction found here:** the deployed instrumentation emits the statement as `db.query.text`, not `db.statement`; the README's TraceQL example used the wrong key and matched nothing (`span.db.statement` → 0 traces, `span.db.query.text` → 3). README and spec corrected. The plan's own text (Task 5 stub, Task 7, Task 9) still says `db.statement`; the stub already falls back to both keys.
- **Task 10 descoped (user ruling, 2026-10-12):** the user asked to close out without the overhead measurement. Consequence: spec success criterion "tracing overhead at a fixed rate is recorded" is **unmet**, and nothing yet says what 100% sampling costs on the 0.5 vCPU task. Any `results.md` row recorded with `trace_sample_ratio = 1` carries that unmeasured cost; the ratio is in the `knobs` output so the row at least names it. To close it later: the Task 10 steps stand unchanged.
- **Task 11 done 2026-10-12:** spec and plan marked complete; phase-2 pointer left in the spec.
