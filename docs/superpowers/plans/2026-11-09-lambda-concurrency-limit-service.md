# lambda-concurrency-limit — Service, Seed, Sizing and Load Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Status:** **complete** (2026-11-09) — all 8 tasks implemented subagent-driven, each reviewed, plus a
  final whole-branch review (no code findings). **Nothing is committed**, by the user's instruction:
  the commit step of every task was skipped, and the files sit in the working tree. Two fix rounds
  were needed: Task 4 (an exported `run()` with tests for the table-read manifest and the refused
  seed) and Task 7 (a 429 adds no sample to `slo_met` or `slo_available`, per the spec's "a 429 is
  never a miss"). Task 8's expected step count is 12, not 11 (arithmetic slip in the task text).
- **Plan 1 of 3** (the spec's "Execution shape"). No AWS, no Terraform. Plan 2 builds the
  infrastructure; plan 3 applies, seeds and measures, with no code changes.

**Goal:** Everything that runs in or against the Lambda, written once: the handler, the OTel
collector config, the seed, the sizing calculator, the SLO source and the four k6 load profiles.

**Architecture:** A CommonJS Node.js 22 package in `lambda-concurrency-limit/service/` holds the
Lambda handler (three GET routes on API Gateway REST proxy events), the seed script and
`capacity.js`. `slo.yaml` is the single source of the class thresholds, objectives and mix; a small
generator writes `infra/k6/tests/lib/slo.js` from it. The k6 profiles send random (Poisson-like)
arrivals by thinning a `constant-arrival-rate` executor.

**Tech Stack:** Node 22.13 (`node --test`), AWS SDK for JavaScript v3 (`@aws-sdk/client-dynamodb`,
`@aws-sdk/lib-dynamodb`), `aws-sdk-client-mock`, `yaml`, k6 v2.3.0.

**Spec:** `docs/superpowers/specs/2026-11-09-lambda-concurrency-limit-design.md`

## Global Constraints

- Project directory `lambda-concurrency-limit/`; every commit is
  `<type>(lambda-concurrency-limit): <subject>`, imperative, lowercase, ≤ 72 characters, with the
  Claude attribution trailers. One commit per task.
- Git is `/usr/bin/git`, one git command per Bash call (worktree hook quirk).
- No AWS call and no Terraform in this plan. Tests need no network and no credentials.
- **Every runtime setting is an environment variable** (spec, "Configuration — every switch"):
  `TABLE_NAME`, `HEAVY_CPU_ITERATIONS`, `AWS_MAX_ATTEMPTS` (read by the SDK itself — the code must
  not set `maxAttempts` on the measured path, or it would override the variable). Plan 3 changes
  behaviour only through these, `dev.tfvars`, seed variables and k6 `-e` values.
- **CommonJS, not ESM, for the Lambda package.** The OTel Node layer instruments through
  `require` hooks; ESM instrumentation of the AWS SDK is not verified for layer v0.24.0, and a
  missing DynamoDB span found in plan 3 would force a code change there.
- Routes and mix are fixed for the life of the project: `GET /items/{pk}/{sk}` (fast, 70%),
  `GET /feeds/{pk}` (standard, 25%), `GET /reports/{pk}` (heavy, 5%).
- Seed defaults: `FEEDS=200`, `ITEMS_PER_FEED=20`, `REPORTS=20`, `ITEMS_PER_REPORT=100`,
  `ITEM_BYTES=1024`. Keys `feed-0000…`/`item-0000…` and `report-000…`/`row-0000…`.
- SLO: latency 95%, availability 99%. A request is good when 2xx and latency ≤ its class threshold.
  A 5xx (including a Lambda throttle, which API Gateway returns as 500) is a miss. A 429 is never a
  miss. Only judged users count: `load` in `constant`/`discovery`/`spike`, `normal-*` in
  `noisy-neighbour`.
- Throttle budget B ≤ 0.5%. Pinned values: B(1,1) = 0.5, B(2,1) = 0.2, B(20,20) = 0.158892,
  B(20,60) = 0.674447; max λ at B ≤ 0.5% and d = 0.2 s is 55 for C = 20 and 404 for C = 100; the
  smallest C for A = 60 is 78.
- Random arrivals: `constant-arrival-rate` at 4 × the target, each iteration sends with
  probability 0.25.
- k6 profiles must pass `k6 inspect` with no `-e` values (the pre-commit hook runs it).

## Review Focus

1. **A seed re-run against a table that was re-created.** A local manifest would say "already
   seeded" and skip every key. Expected: the seed reads its manifest from the table itself, so an
   empty table is fully seeded. Pinned in Task 4 (`seedItems` with `prev = null`), and `main` reads
   the marker item, never the local file.
2. **A seed with smaller numbers or a different `ITEM_BYTES`.** Expected: it refuses with a message
   to re-create the table, and writes nothing. Pinned in Task 4.
3. **A report partition bigger than 1 MB** (`ITEMS_PER_REPORT` raised past ~1,000 at 1 KB). A single
   `Query` returns at most 1 MB. Expected: the handler pages until `LastEvaluatedKey` is empty, so the
   heavy route's cost keeps growing with the seed. Pinned in Task 2.
4. **A DynamoDB error mid-request** (throttle after the SDK's retries, or a missing table).
   Expected: a 500 with a fixed JSON body and one structured log line — never the error message to
   the client, never an unhandled rejection. Pinned in Task 2.
5. **An unknown route or an unseeded key.** Expected: 404, not 500. Pinned in Task 2.

---

## File Structure

```
lambda-concurrency-limit/
  .gitignore                     seed-manifest.json, dist/
  slo.yaml                       objectives, class thresholds (provisional), mix
  service/
    package.json                 CommonJS, scripts: test, seed, capacity, slo:generate, slo:check
    collector.yaml               OTel collector extension config (batch → decouple → otlphttp)
    src/config.js                env → config, validated
    src/cpu.js                   deterministic CPU cost (pbkdf2), from the sibling
    src/dynamo.js                getItem, queryAll (paged)
    src/handler.js               routes, responses, the exported Lambda handler
    scripts/seed.js              items, additive plan, writeAll, manifest
    scripts/capacity.js          Erlang B, sizing, RCU, CLI
    scripts/generate-slo.js      slo.yaml → infra/k6/tests/lib/slo.js
    test/*.test.js               one file per module
  infra/k6/tests/
    lib/env.js                   BASE_URL, keys, seed shape, cloud options
    lib/slo.js                   GENERATED
    lib/mix.js                   20-step class cycle
    lib/arrivals.js              thinning, VU sizing (pure, no k6 imports)
    lib/request.js               one GET, SLI metrics
    constant.js discovery.js spike.js noisy-neighbour.js
```

---

### Task 1: Package scaffold and config

**Files:**
- Create: `lambda-concurrency-limit/.gitignore`, `lambda-concurrency-limit/service/package.json`,
  `lambda-concurrency-limit/service/src/config.js`
- Test: `lambda-concurrency-limit/service/test/config.test.js`

**Interfaces:**
- Produces: `loadConfig(env = process.env) → { tableName: string, heavyCpuIterations: number }`;
  throws `Error` naming the variable when `TABLE_NAME` is missing or `HEAVY_CPU_ITERATIONS` is not
  a non-negative integer.

- [ ] **Step 1: Create the scaffold**

`lambda-concurrency-limit/.gitignore`:

```
# written by service/scripts/seed.js; describes the live table, not the repo
service/seed-manifest.json
# built by scripts/deploy-service.sh (plan 2)
service/dist/
```

`lambda-concurrency-limit/service/package.json`:

```json
{
  "name": "lambda-concurrency-limit",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "node --test",
    "seed": "node scripts/seed.js",
    "capacity": "node scripts/capacity.js",
    "slo:generate": "node scripts/generate-slo.js",
    "slo:check": "node scripts/generate-slo.js --check"
  },
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.716.0",
    "@aws-sdk/lib-dynamodb": "^3.716.0"
  },
  "devDependencies": {
    "aws-sdk-client-mock": "^4.1.0",
    "yaml": "^2.6.0"
  }
}
```

Run: `cd lambda-concurrency-limit/service && npm install`
Expected: `package-lock.json` created, no errors.

- [ ] **Step 2: Write the failing test**

`service/test/config.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

test('reads TABLE_NAME and HEAVY_CPU_ITERATIONS', () => {
  assert.deepEqual(loadConfig({ TABLE_NAME: 't', HEAVY_CPU_ITERATIONS: '5000' }),
    { tableName: 't', heavyCpuIterations: 5000 });
});

test('HEAVY_CPU_ITERATIONS defaults to 0', () => {
  assert.equal(loadConfig({ TABLE_NAME: 't' }).heavyCpuIterations, 0);
});

test('a missing TABLE_NAME fails at load, naming the variable', () => {
  assert.throws(() => loadConfig({}), /TABLE_NAME/);
});

test('a non-integer or negative HEAVY_CPU_ITERATIONS fails, naming the variable', () => {
  for (const v of ['-1', '1.5', 'abc'])
    assert.throws(() => loadConfig({ TABLE_NAME: 't', HEAVY_CPU_ITERATIONS: v }), /HEAVY_CPU_ITERATIONS/);
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd lambda-concurrency-limit/service && node --test test/config.test.js`
Expected: FAIL, `Cannot find module '../src/config'`.

- [ ] **Step 4: Implement**

`service/src/config.js`:

```js
'use strict';

function count(env, key, dflt) {
  const raw = env[key];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return n;
}

// Every runtime setting is an environment variable set by Terraform, so a knob is a
// dev.tfvars edit, never a code change. AWS_MAX_ATTEMPTS is deliberately absent: the
// SDK reads it itself, and setting maxAttempts in code would override it.
function loadConfig(env = process.env) {
  if (!env.TABLE_NAME) throw new Error('TABLE_NAME is required');
  return { tableName: env.TABLE_NAME, heavyCpuIterations: count(env, 'HEAVY_CPU_ITERATIONS', 0) };
}

module.exports = { loadConfig };
```

- [ ] **Step 5: Run it to see it pass**

Run: `node --test test/config.test.js`
Expected: 4 pass.

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add lambda-concurrency-limit/.gitignore lambda-concurrency-limit/service/package.json lambda-concurrency-limit/service/package-lock.json lambda-concurrency-limit/service/src/config.js lambda-concurrency-limit/service/test/config.test.js
```
```bash
/usr/bin/git commit -m "feat(lambda-concurrency-limit): add service package and env config"
```

---

### Task 2: DynamoDB repo, CPU cost and the handler

**Files:**
- Create: `service/src/dynamo.js`, `service/src/cpu.js`, `service/src/handler.js`
- Test: `service/test/dynamo.test.js`, `service/test/handler.test.js`

**Interfaces:**
- Consumes: `loadConfig` (Task 1).
- Produces:
  - `createRepo({ tableName }, doc?) → { getItem(pk, sk) → item|null, queryAll(pk) → item[] }`
  - `burn(iterations: number, seed: string) → string`
  - `createHandler({ repo, config }) → async (event) → { statusCode, headers, body }`
  - `exports.handler` — the Lambda entry point (`src/handler.handler`), built lazily once per
    execution environment.

- [ ] **Step 1: Write the failing tests**

`service/test/dynamo.test.js`:

```js
'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mockClient } = require('aws-sdk-client-mock');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { createRepo } = require('../src/dynamo');

const ddb = mockClient(DynamoDBDocumentClient);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const repo = createRepo({ tableName: 't' }, doc);
beforeEach(() => ddb.reset());

test('getItem reads eventually consistent and returns null for a missing key', async () => {
  ddb.on(GetCommand).resolves({});
  assert.equal(await repo.getItem('feed-0000', 'item-0000'), null);
  const input = ddb.commandCalls(GetCommand)[0].args[0].input;
  assert.deepEqual(input, { TableName: 't', Key: { pk: 'feed-0000', sk: 'item-0000' }, ConsistentRead: false });
});

test('queryAll pages until LastEvaluatedKey is empty', async () => {
  ddb.on(QueryCommand)
    .resolvesOnce({ Items: [{ sk: 'a' }], LastEvaluatedKey: { pk: 'p', sk: 'a' } })
    .resolvesOnce({ Items: [{ sk: 'b' }] });
  assert.deepEqual(await repo.queryAll('p'), [{ sk: 'a' }, { sk: 'b' }]);
  const calls = ddb.commandCalls(QueryCommand);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args[0].input.ExclusiveStartKey, { pk: 'p', sk: 'a' });
  assert.equal(calls[0].args[0].input.ConsistentRead, false);
});
```

`service/test/handler.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../src/handler');

const items = { 'feed-0001/item-0002': { pk: 'feed-0001', sk: 'item-0002', body: 'x' } };
const parts = { 'feed-0001': [{ sk: 'item-0000' }, { sk: 'item-0001' }], 'report-001': [{ sk: 'row-0000' }] };
const repo = {
  async getItem(pk, sk) { return items[`${pk}/${sk}`] ?? null; },
  async queryAll(pk) { return parts[pk] ?? []; },
};
const handle = createHandler({ repo, config: { heavyCpuIterations: 10 } });
const ev = (resource, pathParameters) => ({ httpMethod: 'GET', resource, pathParameters });

test('fast route returns the item', async () => {
  const r = await handle(ev('/items/{pk}/{sk}', { pk: 'feed-0001', sk: 'item-0002' }));
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).sk, 'item-0002');
});

test('standard route returns the partition items', async () => {
  const r = await handle(ev('/feeds/{pk}', { pk: 'feed-0001' }));
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).items.length, 2);
});

test('heavy route returns a count and a digest, not the items', async () => {
  const r = await handle(ev('/reports/{pk}', { pk: 'report-001' }));
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.count, 1);
  assert.match(body.digest, /^[0-9a-f]{16}$/);
});

test('an unseeded key or partition is 404', async () => {
  assert.equal((await handle(ev('/items/{pk}/{sk}', { pk: 'feed-9999', sk: 'item-0000' }))).statusCode, 404);
  assert.equal((await handle(ev('/feeds/{pk}', { pk: 'feed-9999' }))).statusCode, 404);
  assert.equal((await handle(ev('/reports/{pk}', { pk: 'report-999' }))).statusCode, 404);
});

test('an unknown route or method is 404', async () => {
  assert.equal((await handle(ev('/nope', {}))).statusCode, 404);
  assert.equal((await handle({ httpMethod: 'POST', resource: '/feeds/{pk}', pathParameters: { pk: 'feed-0001' } })).statusCode, 404);
});

test('a repo error is a 500 with a fixed body and one log line naming the error', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (line) => logged.push(line));
  const err = Object.assign(new Error('secret detail'), { name: 'ProvisionedThroughputExceededException' });
  const failing = createHandler({ repo: { getItem: async () => { throw err; } }, config: { heavyCpuIterations: 0 } });
  const r = await failing(ev('/items/{pk}/{sk}', { pk: 'a', sk: 'b' }));
  assert.equal(r.statusCode, 500);
  assert.deepEqual(JSON.parse(r.body), { error: 'internal' });
  assert.equal(logged.length, 1);
  assert.equal(JSON.parse(logged[0]).error, 'ProvisionedThroughputExceededException');
  assert.doesNotMatch(r.body, /secret detail/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/dynamo.test.js test/handler.test.js`
Expected: FAIL, `Cannot find module '../src/dynamo'` / `'../src/handler'`.

- [ ] **Step 3: Implement**

`service/src/cpu.js` (copied from `ecs-dynamodb-rps/service/src/cpu.js`, converted to CommonJS):

```js
'use strict';
const { pbkdf2Sync } = require('node:crypto');

const SALT = Buffer.from('lambda-concurrency-limit');

// Deterministic CPU cost counted in iterations, not milliseconds: Lambda gives CPU in
// proportion to memory, so the same count takes less time with more memory.
function burn(iterations, seed) {
  if (!(iterations > 0)) return '0'.repeat(16);
  return pbkdf2Sync(seed, SALT, iterations, 8, 'sha256').toString('hex');
}

module.exports = { burn };
```

`service/src/dynamo.js`:

```js
'use strict';
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

// No maxAttempts here: the SDK reads AWS_MAX_ATTEMPTS from the environment, which is the
// sdk_max_attempts knob. Eventually consistent reads cost 0.5 RCU per 4 KB; the sizing
// arithmetic assumes it.
function createRepo({ tableName }, doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))) {
  return {
    async getItem(pk, sk) {
      const r = await doc.send(new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: false }));
      return r.Item ?? null;
    },
    // Pages past the 1 MB Query limit, so a bigger seed keeps raising the route's cost.
    async queryAll(pk) {
      const items = [];
      let ExclusiveStartKey;
      do {
        const r = await doc.send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': pk },
          ConsistentRead: false,
          ExclusiveStartKey,
        }));
        items.push(...(r.Items ?? []));
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items;
    },
  };
}

module.exports = { createRepo };
```

`service/src/handler.js`:

```js
'use strict';
const { loadConfig } = require('./config');
const { createRepo } = require('./dynamo');
const { burn } = require('./cpu');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const NOT_FOUND = json(404, { error: 'not found' });

function createHandler({ repo, config }) {
  // Keyed on API Gateway's resource template, so there is no path parsing to get wrong.
  const routes = {
    'GET /items/{pk}/{sk}': async ({ pk, sk }) => {
      const item = await repo.getItem(pk, sk);
      return item ? json(200, item) : NOT_FOUND;
    },
    'GET /feeds/{pk}': async ({ pk }) => {
      const items = await repo.queryAll(pk);
      return items.length ? json(200, { items }) : NOT_FOUND;
    },
    'GET /reports/{pk}': async ({ pk }) => {
      const items = await repo.queryAll(pk);
      if (!items.length) return NOT_FOUND;
      return json(200, { count: items.length, digest: burn(config.heavyCpuIterations, pk) });
    },
  };

  return async (event) => {
    const route = routes[`${event.httpMethod} ${event.resource}`];
    if (!route) return NOT_FOUND;
    try {
      return await route(event.pathParameters ?? {});
    } catch (err) {
      console.error(JSON.stringify({ msg: 'request failed', route: event.resource, error: err.name }));
      return json(500, { error: 'internal' });
    }
  };
}

// Built once per execution environment and reused by every warm invocation.
let handle;
exports.handler = async (event) => {
  if (!handle) {
    const config = loadConfig();
    handle = createHandler({ repo: createRepo(config), config });
  }
  return handle(event);
};
exports.createHandler = createHandler;
```

- [ ] **Step 4: Run them to see them pass**

Run: `node --test`
Expected: all tests pass (config, dynamo, handler).

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add lambda-concurrency-limit/service/src lambda-concurrency-limit/service/test/dynamo.test.js lambda-concurrency-limit/service/test/handler.test.js
```
```bash
/usr/bin/git commit -m "feat(lambda-concurrency-limit): add get-only handler over dynamodb"
```

---

### Task 3: OTel collector config

**Files:**
- Create: `service/collector.yaml`
- Test: `service/test/collector.test.js`

**Interfaces:**
- Produces: a file the collector extension reads from
  `OPENTELEMETRY_COLLECTOR_CONFIG_URI=/var/task/collector.yaml` (set in plan 2). It reads two
  environment variables, also set in plan 2: `GRAFANA_OTLP_ENDPOINT`
  (`https://otlp-gateway-<region>.grafana.net/otlp`) and `GRAFANA_OTLP_AUTH`
  (`Basic <base64(instance:token)>`, built with `tr -d '\n'` — a trailing newline invalidates the
  header).

- [ ] **Step 1: Write the failing test**

`service/test/collector.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const cfg = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'collector.yaml'), 'utf8'));

test('traces go otlp -> batch -> decouple -> otlphttp, decouple last', () => {
  const p = cfg.service.pipelines.traces;
  assert.deepEqual(p.receivers, ['otlp']);
  assert.deepEqual(p.processors, ['batch', 'decouple']);
  assert.deepEqual(p.exporters, ['otlphttp']);
});

test('the exporter takes endpoint and auth from the environment, never a literal', () => {
  const e = cfg.exporters.otlphttp;
  assert.equal(e.endpoint, '${env:GRAFANA_OTLP_ENDPOINT}');
  assert.equal(e.headers.Authorization, '${env:GRAFANA_OTLP_AUTH}');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/collector.test.js`
Expected: FAIL, `ENOENT ... collector.yaml`.

- [ ] **Step 3: Write the config**

`service/collector.yaml`:

```yaml
# OTel collector extension (opentelemetry-collector-arm64 layer). The Node layer sends
# spans to localhost; this forwards them to Grafana Cloud Tempo.
# decouple must be LAST: it lets the response return before the export. The export is
# still billed and still occupies the concurrency slot (PostRuntimeExtensionsDuration).
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: localhost:4317
      http:
        endpoint: localhost:4318
processors:
  batch: {}
  decouple: {}
exporters:
  otlphttp:
    endpoint: ${env:GRAFANA_OTLP_ENDPOINT}
    headers:
      Authorization: ${env:GRAFANA_OTLP_AUTH}
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, decouple]
      exporters: [otlphttp]
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/collector.test.js`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add lambda-concurrency-limit/service/collector.yaml lambda-concurrency-limit/service/test/collector.test.js
```
```bash
/usr/bin/git commit -m "feat(lambda-concurrency-limit): add otel collector extension config"
```

---

### Task 4: Additive seed with a manifest

**Files:**
- Create: `service/scripts/seed.js`
- Test: `service/test/seed.test.js`

**Interfaces:**
- Produces (all exported for tests; `upload-k6.sh` in plan 2 reads the manifest file):
  - `seedParams(env) → { feeds, itemsPerFeed, reports, itemsPerReport, itemBytes }`
  - `buildItem(pk, sk, itemBytes) → { pk, sk, body }` of exactly `itemBytes`
  - `itemSizeBytes(item) → number`
  - `seedItems(params, prev = null) → item[]` — only keys not covered by `prev`
  - `chunk(arr, n)`, `writeAll(doc, table, items, opts) → number` (from the sibling, unchanged)
  - Manifest, stored as table item `{ pk: '_manifest', sk: '_manifest', ... }` and as
    `service/seed-manifest.json`: `{ table, params, items, bytes, seededAt }`.

- [ ] **Step 1: Write the failing test**

`service/test/seed.test.js`:

```js
'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mockClient } = require('aws-sdk-client-mock');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { seedParams, buildItem, itemSizeBytes, seedItems, chunk, writeAll } = require('../scripts/seed');

const SMALL = { feeds: 3, itemsPerFeed: 2, reports: 2, itemsPerReport: 4, itemBytes: 512 };
const ddb = mockClient(DynamoDBDocumentClient);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const noSleep = async () => {};
beforeEach(() => ddb.reset());

test('defaults match the spec', () => {
  assert.deepEqual(seedParams({}), { feeds: 200, itemsPerFeed: 20, reports: 20, itemsPerReport: 100, itemBytes: 1024 });
});

test('a value outside the key width or below 1 is refused', () => {
  assert.throws(() => seedParams({ FEEDS: '10001' }), /FEEDS/);
  assert.throws(() => seedParams({ REPORTS: '1001' }), /REPORTS/);
  assert.throws(() => seedParams({ ITEMS_PER_FEED: '0' }), /ITEMS_PER_FEED/);
});

test('every item is exactly ITEM_BYTES', () => {
  for (const it of seedItems(SMALL)) assert.equal(itemSizeBytes(it), 512);
  assert.throws(() => buildItem('feed-0000', 'item-0000', 20), /ITEM_BYTES/);
});

test('an empty table gets every key, deterministically', () => {
  const items = seedItems(SMALL);
  assert.equal(items.length, 3 * 2 + 2 * 4);
  assert.equal(items[0].pk, 'feed-0000');
  assert.equal(items[0].sk, 'item-0000');
  assert.equal(items.at(-1).pk, 'report-001');
  assert.equal(items.at(-1).sk, 'row-0003');
  assert.deepEqual(seedItems(SMALL), items);
});

test('a bigger seed writes only the new keys', () => {
  const next = { ...SMALL, feeds: 4, itemsPerReport: 5 };
  const keys = seedItems(next, SMALL).map((i) => `${i.pk}/${i.sk}`);
  // feed-0003 is new (2 items); each of the 2 reports gains row-0004
  assert.deepEqual(keys.sort(), ['feed-0003/item-0000', 'feed-0003/item-0001', 'report-000/row-0004', 'report-001/row-0004']);
});

test('the same seed again writes nothing', () => {
  assert.deepEqual(seedItems(SMALL, SMALL), []);
});

test('a smaller seed or a new item size is refused', () => {
  assert.throws(() => seedItems({ ...SMALL, feeds: 2 }, SMALL), /re-create the table/);
  assert.throws(() => seedItems({ ...SMALL, itemBytes: 1024 }, SMALL), /re-create the table/);
});

test('chunk splits into groups of 25', () => {
  assert.deepEqual(chunk([...Array(60).keys()], 25).map((g) => g.length), [25, 25, 10]);
});

test('writeAll retries UnprocessedItems and completes', async () => {
  const items = seedItems(SMALL);
  ddb.on(BatchWriteCommand)
    .resolvesOnce({ UnprocessedItems: { t: [{ PutRequest: { Item: items[0] } }] } })
    .resolves({});
  assert.equal(await writeAll(doc, 't', items, { sleep: noSleep, batchDelayMs: 0 }), items.length);
  assert.equal(ddb.commandCalls(BatchWriteCommand).length, 2);
});

test('writeAll retries a thrown throttle, and re-throws anything else at once', async () => {
  const items = seedItems(SMALL);
  const throttle = Object.assign(new Error('t'), { name: 'ProvisionedThroughputExceededException' });
  ddb.on(BatchWriteCommand).rejectsOnce(throttle).resolves({});
  assert.equal(await writeAll(doc, 't', items, { sleep: noSleep, batchDelayMs: 0 }), items.length);

  ddb.reset();
  ddb.on(BatchWriteCommand).rejects(Object.assign(new Error('v'), { name: 'ValidationException' }));
  await assert.rejects(writeAll(doc, 't', items, { sleep: noSleep, batchDelayMs: 0 }), /v/);
  assert.equal(ddb.commandCalls(BatchWriteCommand).length, 1);
});

test('writeAll throws naming the count when throttling never stops', async () => {
  const items = seedItems(SMALL);
  ddb.on(BatchWriteCommand).callsFake((input) => ({ UnprocessedItems: input.RequestItems }));
  await assert.rejects(writeAll(doc, 't', items, { sleep: noSleep, batchDelayMs: 0, attempts: 2 }), /14 item\(s\) remained unwritten/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/seed.test.js`
Expected: FAIL, `Cannot find module '../scripts/seed'`.

- [ ] **Step 3: Implement**

`service/scripts/seed.js` (`chunk`, `isThrottlingError` and `writeAll` copied from
`ecs-dynamodb-rps/service/scripts/seed.js`, converted to CommonJS; the rest is new):

```js
'use strict';
// Forked from ecs-dynamodb-rps/service/scripts/seed.js on 2026-11-09 (chunk, writeAll).
// A bug fixed here does not reach the sibling copy; fix both.
const fs = require('node:fs');
const path = require('node:path');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, BatchWriteCommand, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');

const BATCH = 25; // BatchWriteItem hard limit
const MANIFEST_KEY = { pk: '_manifest', sk: '_manifest' };
const MANIFEST_FILE = path.join(__dirname, '..', 'seed-manifest.json');
// name -> [env var, default, max]; max is set by the key width (feed-0000, report-000, item-0000)
const PARAMS = {
  feeds: ['FEEDS', 200, 10000],
  itemsPerFeed: ['ITEMS_PER_FEED', 20, 10000],
  reports: ['REPORTS', 20, 1000],
  itemsPerReport: ['ITEMS_PER_REPORT', 100, 10000],
  itemBytes: ['ITEM_BYTES', 1024, 400000], // 400 KB is DynamoDB's item size limit
};

function seedParams(env = process.env) {
  const out = {};
  for (const [name, [key, dflt, max]] of Object.entries(PARAMS)) {
    const raw = env[key];
    const n = raw === undefined || raw === '' ? dflt : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${key} must be an integer in 1..${max}, got ${JSON.stringify(raw)}`);
    out[name] = n;
  }
  return out;
}

/** DynamoDB charges attribute names plus values, UTF-8. */
function itemSizeBytes(item) {
  return Object.entries(item).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(String(v)), 0);
}

function buildItem(pk, sk, itemBytes) {
  const pad = itemBytes - itemSizeBytes({ pk, sk, body: '' });
  if (pad < 1) throw new Error(`ITEM_BYTES=${itemBytes} is too small for key ${pk}/${sk}`);
  return { pk, sk, body: 'x'.repeat(pad) };
}

const p4 = (n) => String(n).padStart(4, '0');
const p3 = (n) => String(n).padStart(3, '0');

/**
 * Every item of `params`, minus those `prev` already wrote. Keys are deterministic, so
 * "seed more" is a bigger number. Shrinking or resizing would leave the table describing
 * two seeds at once, so it is refused.
 */
function seedItems(params, prev = null) {
  if (prev) {
    const smaller = Object.keys(PARAMS).filter((k) => k !== 'itemBytes' && params[k] < prev[k]);
    if (smaller.length || params.itemBytes !== prev.itemBytes)
      throw new Error(`seed ${JSON.stringify(params)} cannot follow ${JSON.stringify(prev)}: only growth is additive; re-create the table`);
  }
  const was = prev ?? { feeds: 0, itemsPerFeed: 0, reports: 0, itemsPerReport: 0 };
  const items = [];
  for (let f = 0; f < params.feeds; f++)
    for (let i = 0; i < params.itemsPerFeed; i++)
      if (f >= was.feeds || i >= was.itemsPerFeed) items.push(buildItem(`feed-${p4(f)}`, `item-${p4(i)}`, params.itemBytes));
  for (let r = 0; r < params.reports; r++)
    for (let i = 0; i < params.itemsPerReport; i++)
      if (r >= was.reports || i >= was.itemsPerReport) items.push(buildItem(`report-${p3(r)}`, `row-${p4(i)}`, params.itemBytes));
  return items;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const defaultSleep = (ms) => new Promise((res) => setTimeout(res, ms));
const THROTTLE_ERROR_NAMES = new Set(['ProvisionedThroughputExceededException', 'ThrottlingException']);
const isThrottlingError = (err) => Boolean(err && THROTTLE_ERROR_NAMES.has(err.name));

/**
 * BatchWriteItem in groups of 25, retrying UnprocessedItems and thrown throttles with
 * backoff. Throws if anything is still unwritten: a short seed silently changes every
 * route's cost.
 */
async function writeAll(doc, tableName, items, { attempts = 5, sleep = defaultSleep, onProgress, batchDelayMs = 0 } = {}) {
  let written = 0;
  const groups = chunk(items, BATCH);
  for (let g = 0; g < groups.length; g++) {
    let pending = groups[g];
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const r = await doc.send(new BatchWriteCommand({
          RequestItems: { [tableName]: pending.map((Item) => ({ PutRequest: { Item } })) },
        }));
        pending = (r.UnprocessedItems?.[tableName] ?? []).map((req) => req.PutRequest.Item);
      } catch (err) {
        if (!isThrottlingError(err)) throw err;
      }
      if (!pending.length) break;
      if (attempt < attempts - 1) await sleep(100 * 2 ** attempt);
    }
    if (pending.length) {
      const remaining = pending.length + groups.slice(g + 1).reduce((n, gr) => n + gr.length, 0);
      throw new Error(`seed incomplete: ${remaining} item(s) remained unwritten after ${attempts} attempt(s)`);
    }
    written += groups[g].length;
    onProgress?.(written, items.length);
    if (batchDelayMs && g < groups.length - 1) await sleep(batchDelayMs);
  }
  return written;
}

async function main() {
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error('TABLE_NAME is required (terraform -chdir=infra/main output -raw table_name)');
  const params = seedParams();
  // The seed is not the measured path, so it may retry harder than the service.
  const base = new DynamoDBClient({ maxAttempts: 8 });
  const doc = DynamoDBDocumentClient.from(base);

  // The manifest is read from the TABLE, not the local file: a re-created table must be
  // seeded in full even if an old seed-manifest.json is still on disk.
  const prev = (await doc.send(new GetCommand({ TableName: table, Key: MANIFEST_KEY }))).Item?.params ?? null;
  const items = seedItems(params, prev);
  await writeAll(doc, table, items, {
    batchDelayMs: Number(process.env.SEED_BATCH_DELAY_MS || 0),
    onProgress: (n, total) => process.stdout.write(`\rseeded ${n}/${total}`),
  });

  const total = params.feeds * params.itemsPerFeed + params.reports * params.itemsPerReport;
  const manifest = { table, params, items: total, bytes: total * params.itemBytes, seededAt: new Date().toISOString() };
  await doc.send(new PutCommand({ TableName: table, Item: { ...MANIFEST_KEY, ...manifest } }));
  fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nwrote ${items.length} new item(s); table holds ${total}; manifest ${MANIFEST_FILE}`);
  base.destroy();
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { seedParams, buildItem, itemSizeBytes, seedItems, chunk, writeAll };
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/seed.test.js`
Expected: all pass. Then `node --test` — the whole suite passes.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add lambda-concurrency-limit/service/scripts/seed.js lambda-concurrency-limit/service/test/seed.test.js
```
```bash
/usr/bin/git commit -m "feat(lambda-concurrency-limit): add additive seed with in-table manifest"
```

---

### Task 5: SLO source and the k6 threshold generator

**Files:**
- Create: `lambda-concurrency-limit/slo.yaml`, `service/scripts/generate-slo.js`,
  `infra/k6/tests/lib/slo.js` (generated)
- Test: `service/test/generate-slo.test.js`

**Interfaces:**
- Produces, in the generated `infra/k6/tests/lib/slo.js`:
  - `CLASS_THRESHOLD_MS = { fast, standard, heavy }`
  - `LATENCY_RATE` (0.95), `AVAILABILITY_RATE` (0.99)
  - `MIX = { fast: 0.70, standard: 0.25, heavy: 0.05 }`
  - `gate(selector) → thresholds object` — the gates for the samples matching a k6 tag selector
    such as `'window:measured'`.
- Produces, from `generate-slo.js`: `render(slo) → string` and `loadSlo(path) → object`.
  `npm run slo:generate` writes; `npm run slo:check` exits 1 when the committed file differs.
  Plan 2 extends this script with the Grafana outputs.

- [ ] **Step 1: Write `slo.yaml`**

`lambda-concurrency-limit/slo.yaml`:

```yaml
service: lambda-concurrency-limit

# Run-scoped attainment over a load run's own window is authoritative. The 7d window
# exists because Grafana's SLO API refuses anything shorter.
window: 7d

# Fixed for the life of the project: changing it voids every recorded run.
mix: { fast: 0.70, standard: 0.25, heavy: 0.05 }

slos:
  - name: latency-classes
    # GOOD = status 2xx AND latency <= the class threshold. 429 is never a miss; only
    # judged users count (load, or normal-* in noisy-neighbour).
    sli: class_threshold_ratio
    objective: 95.0
    # PROVISIONAL. Frozen in plan 3, phase 0: threshold = API Gateway overhead + warm
    # p99 latency with OTel on, plus a margin, rounded up. Then `npm run slo:generate`.
    frozen: false
    classes:
      fast:     { threshold_ms: 300,  route: "GET /items/{pk}/{sk}" }
      standard: { threshold_ms: 400,  route: "GET /feeds/{pk}" }
      heavy:    { threshold_ms: 1000, route: "GET /reports/{pk}" }
  - name: availability
    # GOOD = status < 500. A Lambda throttle reaches the client as API Gateway's 500.
    sli: success_rate
    objective: 99.0
```

- [ ] **Step 2: Write the failing test**

`service/test/generate-slo.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { render, loadSlo, SLO_PATH, OUT_PATH } = require('../scripts/generate-slo');

const slo = loadSlo(SLO_PATH);

test('renders thresholds, objectives and mix from slo.yaml', () => {
  const out = render(slo);
  assert.match(out, /CLASS_THRESHOLD_MS = \{"fast":300,"standard":400,"heavy":1000\}/);
  assert.match(out, /LATENCY_RATE = 0\.95;/);
  assert.match(out, /AVAILABILITY_RATE = 0\.99;/);
  assert.match(out, /MIX = \{"fast":0\.7,"standard":0\.25,"heavy":0\.05\}/);
});

test('the mix sums to 1', () => {
  const sum = Object.values(slo.mix).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `mix sums to ${sum}`);
});

test('the committed lib/slo.js is what slo.yaml generates', () => {
  assert.equal(fs.readFileSync(OUT_PATH, 'utf8'), render(slo));
});

test('a missing class threshold is refused', () => {
  const bad = structuredClone(slo);
  bad.slos[0].classes.fast.threshold_ms = null;
  assert.throws(() => render(bad), /fast/);
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --test test/generate-slo.test.js`
Expected: FAIL, `Cannot find module '../scripts/generate-slo'`.

- [ ] **Step 4: Implement**

`service/scripts/generate-slo.js`:

```js
'use strict';
// slo.yaml is the single source; this writes the k6 side. Plan 2 adds the Grafana side.
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..', '..');
const SLO_PATH = path.join(ROOT, 'slo.yaml');
const OUT_PATH = path.join(ROOT, 'infra', 'k6', 'tests', 'lib', 'slo.js');
const CLASSES = ['fast', 'standard', 'heavy'];

const loadSlo = (p) => YAML.parse(fs.readFileSync(p, 'utf8'));

function render(slo) {
  const lat = slo.slos.find((s) => s.name === 'latency-classes');
  const avail = slo.slos.find((s) => s.name === 'availability');
  const ms = {};
  for (const c of CLASSES) {
    const t = lat.classes[c]?.threshold_ms;
    if (!(t > 0)) throw new Error(`slo.yaml: class ${c} has no threshold_ms`);
    ms[c] = t;
  }
  const mix = Object.fromEntries(CLASSES.map((c) => [c, slo.mix[c]]));
  return `// GENERATED from slo.yaml by npm run slo:generate. Do not edit by hand.
// Thresholds frozen: ${lat.frozen === true}.
export const CLASS_THRESHOLD_MS = ${JSON.stringify(ms)};
export const LATENCY_RATE = ${lat.objective / 100};
export const AVAILABILITY_RATE = ${avail.objective / 100};
export const MIX = ${JSON.stringify(mix)};

// The gates for the samples matching one tag selector, e.g. 'window:measured'. Only
// judged users add samples to slo_met and slo_available (lib/request.js).
export function gate(selector) {
  return {
    [\`slo_met{\${selector}}\`]: [\`rate>=\${LATENCY_RATE}\`],
    [\`slo_available{\${selector}}\`]: [\`rate>=\${AVAILABILITY_RATE}\`],
    // An arrival-rate run that runs out of VUs delivers less than its rate and then
    // passes at that lower rate. Such a run is not a measurement. Refuse it.
    dropped_iterations: ['count==0'],
    // Reported, not gated: a threshold that cannot fail makes k6 print the sub-metric.
    [\`http_req_duration{class:fast,\${selector}}\`]: ['p(95)>=0', 'p(99)>=0'],
    [\`http_req_duration{class:standard,\${selector}}\`]: ['p(95)>=0', 'p(99)>=0'],
    [\`http_req_duration{class:heavy,\${selector}}\`]: ['p(95)>=0', 'p(99)>=0'],
    [\`rate_limited{\${selector}}\`]: ['rate>=0'],
  };
}
`;
}

if (require.main === module) {
  const out = render(loadSlo(SLO_PATH));
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : '';
    if (current !== out) { console.error(`${OUT_PATH} is stale: run npm run slo:generate`); process.exit(1); }
  } else {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, out);
    console.log(`wrote ${OUT_PATH}`);
  }
}

module.exports = { render, loadSlo, SLO_PATH, OUT_PATH };
```

Run: `npm run slo:generate`
Expected: `wrote .../infra/k6/tests/lib/slo.js`.

- [ ] **Step 5: Run it to see it pass**

Run: `node --test test/generate-slo.test.js && npm run slo:check`
Expected: 4 pass; `slo:check` exits 0.

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add lambda-concurrency-limit/slo.yaml lambda-concurrency-limit/service/scripts/generate-slo.js lambda-concurrency-limit/service/test/generate-slo.test.js lambda-concurrency-limit/infra/k6/tests/lib/slo.js
```
```bash
/usr/bin/git commit -m "feat(lambda-concurrency-limit): add slo source and k6 threshold generator"
```

---

### Task 6: Sizing calculator

**Files:**
- Create: `service/scripts/capacity.js`
- Test: `service/test/capacity.test.js`

**Interfaces:**
- Consumes: `loadSlo`, `SLO_PATH` (Task 5) for the mix.
- Produces:
  - `erlangB(c, A) → number` (refused fraction)
  - `minConcurrency(A, target) → integer`
  - `maxRate(c, d, target) → number` (largest λ with `erlangB(c, λ·d) ≤ target`)
  - `rcuPerRequest(params, mix) → number` (eventually consistent, rounded per 4 KB of the total)
  - CLI: `npm run capacity -- --c 20 --d 0.2 [--rps 300] [--target 0.005] [--manifest seed-manifest.json] [--headroom 0.2]`

- [ ] **Step 1: Write the failing test**

`service/test/capacity.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { erlangB, minConcurrency, maxRate, rcuPerRequest } = require('../scripts/capacity');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('Erlang B textbook values', () => {
  close(erlangB(1, 1), 0.5);
  close(erlangB(2, 1), 0.2);
  close(erlangB(0, 5), 1);
});

test('Erlang B values the spec quotes', () => {
  close(erlangB(20, 20), 0.158892);
  close(erlangB(100, 100), 0.075700);
  close(erlangB(20, 60), 0.674447);
});

test('max rate at B <= 0.5% and d = 0.2 s', () => {
  assert.equal(Math.floor(maxRate(20, 0.2, 0.005)), 55);
  assert.equal(Math.floor(maxRate(100, 0.2, 0.005)), 404);
  assert.ok(erlangB(20, maxRate(20, 0.2, 0.005) * 0.2) <= 0.005);
});

test('smallest concurrency for A = 60 at B <= 0.5% is 78', () => {
  assert.equal(minConcurrency(60, 0.005), 78);
});

test('RCU per request for the default seed and mix is 1.6', () => {
  const params = { itemsPerFeed: 20, itemsPerReport: 100, itemBytes: 1024 };
  close(rcuPerRequest(params, { fast: 0.70, standard: 0.25, heavy: 0.05 }), 1.6);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/capacity.test.js`
Expected: FAIL, `Cannot find module '../scripts/capacity'`.

- [ ] **Step 3: Implement**

`service/scripts/capacity.js`:

```js
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
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/capacity.test.js && npm run capacity -- --c 20 --d 0.2 --rps 300`
Expected: 5 pass; the CLI prints `"maxRpsAtTarget": 55`, `"throttledFraction": 0.674...`,
`"minReservedForTarget": 78`.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add lambda-concurrency-limit/service/scripts/capacity.js lambda-concurrency-limit/service/test/capacity.test.js
```
```bash
/usr/bin/git commit -m "feat(lambda-concurrency-limit): add erlang b sizing calculator"
```

---

### Task 7: k6 shared library — env, mix, arrivals, request

**Files:**
- Create: `infra/k6/tests/lib/env.js`, `lib/mix.js`, `lib/arrivals.js`, `lib/request.js`
- Test: `service/test/k6-lib.test.js` (imports the two pure modules)

**Interfaces:**
- Consumes: `CLASS_THRESHOLD_MS`, `MIX` from the generated `lib/slo.js` (Task 5).
- Produces:
  - `env.js`: `BASE_URL`, `USER_AGENT`, `SEED = { feeds, itemsPerFeed, reports, itemsPerReport }`,
    `KEYS = { load, 'normal-1'…'normal-4', noisy }`, `CLOUD` (k6 `options.cloud` without `name`).
  - `mix.js`: `CYCLE` (20 entries), `classOf(iteration) → 'fast'|'standard'|'heavy'`.
  - `arrivals.js`: `OVERSAMPLE = 4`, `SEND_PROBABILITY = 0.25`, `iterationRate(targetRps)`,
    `shouldSend(random = Math.random) → boolean`, `vus(targetRps) → { preAllocatedVUs, maxVUs }`.
  - `request.js`: metrics `slo_met`, `slo_available`, `rate_limited` (all `Rate`);
    `doRequest({ user, judged, tags }) → res`.

- [ ] **Step 1: Write the failing test**

`service/test/k6-lib.test.js` (Node 22 loads these ES modules through `import()`; they import
nothing from k6):

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadSlo, SLO_PATH } = require('../scripts/generate-slo');

const lib = (f) => import(path.join(__dirname, '..', '..', 'infra', 'k6', 'tests', 'lib', f));

// Deterministic uniform source, so the statistics below do not flake.
function lcg(seed = 42) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

test('the 20-step cycle carries the slo.yaml mix exactly', async () => {
  const { CYCLE } = await lib('mix.js');
  const mix = loadSlo(SLO_PATH).mix;
  assert.equal(CYCLE.length, 20);
  for (const c of ['fast', 'standard', 'heavy'])
    assert.equal(CYCLE.filter((x) => x === c).length / 20, mix[c]);
});

test('thinning sends 1 in 4 at the target rate', async () => {
  const { shouldSend, iterationRate } = await lib('arrivals.js');
  assert.equal(iterationRate(55), 220);
  const rnd = lcg();
  let sent = 0;
  for (let i = 0; i < 200000; i++) if (shouldSend(rnd)) sent++;
  assert.ok(Math.abs(sent / 200000 - 0.25) < 0.005, `sent fraction ${sent / 200000}`);
});

test('thinned gaps are near-random: CV = sqrt(1 - p) = 0.866, against 0 for even arrivals', async () => {
  const { shouldSend } = await lib('arrivals.js');
  const rnd = lcg(7);
  const gaps = [];
  let last = -1;
  for (let slot = 0; slot < 400000; slot++) {
    if (!shouldSend(rnd)) continue;
    if (last >= 0) gaps.push(slot - last);
    last = slot;
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  assert.ok(Math.abs(sd / mean - Math.sqrt(0.75)) < 0.02, `CV ${sd / mean}`);
});

test('VU sizing scales with the iteration rate and never drops below 10', async () => {
  const { vus } = await lib('arrivals.js');
  assert.deepEqual(vus(1), { preAllocatedVUs: 10, maxVUs: 40 });
  assert.ok(vus(400).maxVUs >= 400);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/k6-lib.test.js`
Expected: FAIL, `Cannot find module .../lib/mix.js`.

- [ ] **Step 3: Implement**

`infra/k6/tests/lib/mix.js`:

```js
// 14 fast, 5 standard, 1 heavy = 70/25/5, slo.yaml's mix. Deterministic over the
// iteration index; thinning then picks a random subset, which keeps the shares.
export const CYCLE = [
  'fast', 'fast', 'standard', 'fast', 'fast',
  'fast', 'standard', 'fast', 'fast', 'standard',
  'fast', 'fast', 'standard', 'fast', 'fast',
  'heavy', 'standard', 'fast', 'fast', 'fast',
];

export const classOf = (iteration) => CYCLE[iteration % CYCLE.length];
```

`infra/k6/tests/lib/arrivals.js`:

```js
// Random arrivals by thinning. k6's constant-arrival-rate starts iterations at even
// intervals, which rarely collide and would show far fewer throttles than Erlang B
// predicts. Running at 4x the target and sending each iteration with p = 0.25 gives
// gaps with CV = sqrt(1 - p) = 0.87 (Poisson is 1, even arrivals 0).
// shortcut: p = 0.25 gives CV 0.87, not 1; lower p (more oversampling) if measured
// throttles stay well below the Erlang B prediction.
export const OVERSAMPLE = 4;
export const SEND_PROBABILITY = 1 / OVERSAMPLE;

export const iterationRate = (targetRps) => Math.round(targetRps * OVERSAMPLE);
export const shouldSend = (random = Math.random) => random() < SEND_PROBABILITY;

// Skipped iterations end at once; a sent one holds a VU for its latency (under 1 s
// even at the heavy threshold). One VU per sent request per second, with 4x room.
export function vus(targetRps) {
  const base = Math.max(10, Math.ceil(targetRps));
  return { preAllocatedVUs: base, maxVUs: base * 4 };
}
```

`infra/k6/tests/lib/env.js`:

```js
// BASE_URL and the API keys reach a run only as -e values or through the archive that
// scripts/upload-k6.sh (plan 2) builds from terraform output. Never in git: the keys
// identify test users, and the URL is a public endpoint.
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:1';
export const USER_AGENT = 'k6/2.3.0';

// The seed shape, from seed-manifest.json via upload-k6.sh. Defaults are the seed's.
export const SEED = {
  feeds: Number(__ENV.FEEDS || 200),
  itemsPerFeed: Number(__ENV.ITEMS_PER_FEED || 20),
  reports: Number(__ENV.REPORTS || 20),
  itemsPerReport: Number(__ENV.ITEMS_PER_REPORT || 100),
};

export const KEYS = {
  load: __ENV.API_KEY_LOAD || '',
  'normal-1': __ENV.API_KEY_NORMAL_1 || '',
  'normal-2': __ENV.API_KEY_NORMAL_2 || '',
  'normal-3': __ENV.API_KEY_NORMAL_3 || '',
  'normal-4': __ENV.API_KEY_NORMAL_4 || '',
  noisy: __ENV.API_KEY_NOISY || '',
};

// Ashburn is next to us-east-1, so the API Gateway overhead `o` is not a transatlantic
// round trip (the ECS siblings ran from Frankfurt against eu-central-1).
export const CLOUD = {
  distribution: { ashburn: { loadZone: 'amazon:us:ashburn', percent: 100 } },
};
```

`infra/k6/tests/lib/request.js`:

```js
import http from 'k6/http';
import exec from 'k6/execution';
import { Rate } from 'k6/metrics';
import { classOf } from './mix.js';
import { CLASS_THRESHOLD_MS } from './slo.js';
import { BASE_URL, KEYS, SEED } from './env.js';

// k6 is the only SLI (spec decision 5). Only judged users add samples to slo_met and
// slo_available; every user adds to rate_limited.
export const sloMet = new Rate('slo_met');
export const sloAvailable = new Rate('slo_available');
export const rateLimited = new Rate('rate_limited');

const p4 = (n) => String(n).padStart(4, '0');
const p3 = (n) => String(n).padStart(3, '0');
const rnd = (n) => Math.floor(Math.random() * n);

export function doRequest({ user, judged, tags = {} }) {
  const cls = classOf(exec.scenario.iterationInTest);
  let url;
  let name;
  if (cls === 'fast') {
    url = `/items/feed-${p4(rnd(SEED.feeds))}/item-${p4(rnd(SEED.itemsPerFeed))}`;
    name = 'GET /items/{pk}/{sk}';
  } else if (cls === 'standard') {
    url = `/feeds/feed-${p4(rnd(SEED.feeds))}`;
    name = 'GET /feeds/{pk}';
  } else {
    url = `/reports/report-${p3(rnd(SEED.reports))}`;
    name = 'GET /reports/{pk}';
  }
  const t = { class: cls, user, ...tags };
  // `name` groups URLs that differ only by key; without it every key is a new metric
  // series, and Grafana Cloud ends the run at its active-series limit (seen 2026-11-04).
  const res = http.get(`${BASE_URL}${url}`, { headers: { 'x-api-key': KEYS[user] }, tags: { ...t, name } });

  rateLimited.add(res.status === 429, t);
  if (judged) {
    // status 0 is a network error: no response at all, so it is a miss.
    sloAvailable.add(res.status > 0 && res.status < 500, t);
    sloMet.add(res.status >= 200 && res.status < 300 && res.timings.duration <= CLASS_THRESHOLD_MS[cls], t);
  }
  return res;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/k6-lib.test.js`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add lambda-concurrency-limit/infra/k6/tests/lib lambda-concurrency-limit/service/test/k6-lib.test.js
```
```bash
/usr/bin/git commit -m "test(lambda-concurrency-limit): add k6 library with thinned arrivals"
```

---

### Task 8: The four load profiles

**Files:**
- Create: `infra/k6/tests/constant.js`, `discovery.js`, `spike.js`, `noisy-neighbour.js`

**Interfaces:**
- Consumes: everything in Task 7, `gate` and `LATENCY_RATE`/`AVAILABILITY_RATE` from `lib/slo.js`.
- Produces, as `-e` variables (all have defaults so `k6 inspect` passes bare):

| profile | variables |
|---|---|
| `constant` | `RATE` (20), `WARMUP_SECONDS` (120), `DURATION_SECONDS` (600) |
| `discovery` | `START_RATE` (10), `STEP_RPS` (10), `MAX_RATE` (120), `STEP_SECONDS` (120), `WARMUP_SECONDS` (60) |
| `spike` | `PEAK_RATE` (50), `BASE_FRACTION` (0.1), `BASE_SECONDS` (180), `SPIKE_SECONDS` (120), `HEAD_SECONDS` (30) |
| `noisy-neighbour` | `NORMAL_RATE` (10), `NOISY_RATE` (60), `WARMUP_SECONDS` (60), `DURATION_SECONDS` (600) |

Rates are frozen from `npm run capacity` in plan 3 and passed by `upload-k6.sh`.

- [ ] **Step 1: Write the profiles**

`infra/k6/tests/constant.js`:

```js
import { gate } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { USER_AGENT, CLOUD } from './lib/env.js';
import { iterationRate, shouldSend, vus } from './lib/arrivals.js';

const RATE = Number(__ENV.RATE || 20);
const WARMUP = Number(__ENV.WARMUP_SECONDS || 120);
const DURATION = Number(__ENV.DURATION_SECONDS || 600);

// The warm-up creates the execution environments, so cold starts fall outside the
// judged window. Only window:measured is gated.
export const options = {
  userAgent: USER_AGENT,
  cloud: { name: 'lambda-concurrency-limit constant', ...CLOUD },
  thresholds: gate('window:measured'),
  scenarios: {
    warmup: {
      executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s',
      stages: [{ target: iterationRate(RATE), duration: `${WARMUP}s` }],
      ...vus(RATE), tags: { window: 'warmup' },
    },
    measured: {
      executor: 'constant-arrival-rate', rate: iterationRate(RATE), timeUnit: '1s',
      duration: `${DURATION}s`, startTime: `${WARMUP}s`,
      ...vus(RATE), tags: { window: 'measured' },
    },
  },
};

export default function () {
  if (shouldSend()) doRequest({ user: 'load', judged: true });
}
```

`infra/k6/tests/discovery.js`:

```js
import { gate, LATENCY_RATE, AVAILABILITY_RATE } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { USER_AGENT, CLOUD } from './lib/env.js';
import { iterationRate, shouldSend, vus } from './lib/arrivals.js';

const START = Number(__ENV.START_RATE || 10);
const STEP = Number(__ENV.STEP_RPS || 10);
const MAX = Number(__ENV.MAX_RATE || 120);
const STEP_SECONDS = Number(__ENV.STEP_SECONDS || 120);
const WARMUP = Number(__ENV.WARMUP_SECONDS || 60);

// The last step whose slo_met and slo_available both pass is the measured capacity at
// this reserved concurrency; compare it with `npm run capacity`. The run stops once the
// whole-run availability is clearly gone.
const scenarios = {
  warmup: {
    executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s',
    stages: [{ target: iterationRate(START), duration: `${WARMUP}s` }],
    ...vus(START), tags: { window: 'warmup' },
  },
};
const thresholds = {
  ...gate('window:step'),
  slo_available: [{ threshold: `rate>=${AVAILABILITY_RATE}`, abortOnFail: true, delayAbortEval: '60s' }],
};
// Each step is gated by its own scenario tag, so `scenario:rps_N` shows where it broke.
delete thresholds['slo_met{window:step}'];
delete thresholds['slo_available{window:step}'];

let i = 0;
for (let rate = START; rate <= MAX; rate += STEP, i++) {
  const name = `rps_${rate}`;
  scenarios[name] = {
    executor: 'constant-arrival-rate', rate: iterationRate(rate), timeUnit: '1s',
    duration: `${STEP_SECONDS}s`, startTime: `${WARMUP + i * STEP_SECONDS}s`,
    ...vus(rate), gracefulStop: '5s', tags: { window: 'step' },
  };
  thresholds[`slo_met{scenario:${name}}`] = [`rate>=${LATENCY_RATE}`];
  thresholds[`slo_available{scenario:${name}}`] = [`rate>=${AVAILABILITY_RATE}`];
}

export const options = {
  userAgent: USER_AGENT,
  cloud: { name: 'lambda-concurrency-limit discovery', ...CLOUD },
  thresholds,
  scenarios,
};

export default function () {
  if (shouldSend()) doRequest({ user: 'load', judged: true });
}
```

`infra/k6/tests/spike.js`:

```js
import exec from 'k6/execution';
import { gate } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { USER_AGENT, CLOUD } from './lib/env.js';
import { iterationRate, shouldSend, vus } from './lib/arrivals.js';

const PEAK = Number(__ENV.PEAK_RATE || 50);
const BASE = Math.max(1, Math.round(PEAK * Number(__ENV.BASE_FRACTION || 0.1)));
const BASE_SECONDS = Number(__ENV.BASE_SECONDS || 180);
const SPIKE_SECONDS = Number(__ENV.SPIKE_SECONDS || 120);
const HEAD_SECONDS = Number(__ENV.HEAD_SECONDS || 30);

// Knob 3 (provisioned concurrency) is judged on p99 and max latency in the first
// HEAD_SECONDS of the spike, where the new environments' cold starts land. Attainment
// over the whole spike is gated as usual and is expected to barely move.
export const options = {
  userAgent: USER_AGENT,
  cloud: { name: 'lambda-concurrency-limit spike', ...CLOUD },
  thresholds: {
    ...gate('window:spike'),
    'http_req_duration{head:yes}': ['p(99)>=0', 'max>=0'],
  },
  scenarios: {
    base: {
      executor: 'constant-arrival-rate', rate: iterationRate(BASE), timeUnit: '1s',
      duration: `${BASE_SECONDS + SPIKE_SECONDS}s`, ...vus(PEAK),
    },
    surge: {
      executor: 'constant-arrival-rate', rate: iterationRate(PEAK - BASE), timeUnit: '1s',
      duration: `${SPIKE_SECONDS}s`, startTime: `${BASE_SECONDS}s`, ...vus(PEAK),
    },
  },
};

export default function () {
  if (!shouldSend()) return;
  // Windows by elapsed time, so base-scenario requests during the spike count too.
  const s = exec.instance.currentTestRunDuration / 1000;
  const window = s < BASE_SECONDS ? 'base' : 'spike';
  const head = s >= BASE_SECONDS && s < BASE_SECONDS + HEAD_SECONDS ? 'yes' : 'no';
  doRequest({ user: 'load', judged: true, tags: { window, head } });
}
```

`infra/k6/tests/noisy-neighbour.js`:

```js
import exec from 'k6/execution';
import { gate } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { USER_AGENT, CLOUD } from './lib/env.js';
import { iterationRate, shouldSend, vus } from './lib/arrivals.js';

const NORMAL = Number(__ENV.NORMAL_RATE || 10);
const NOISY = Number(__ENV.NOISY_RATE || 60);
const WARMUP = Number(__ENV.WARMUP_SECONDS || 60);
const DURATION = Number(__ENV.DURATION_SECONDS || 600);

// One scenario per user; the scenario name is the user and selects its API key. The SLO
// is judged over normal-* only (spec decision 6): the noisy user's 429s are the limit
// working. rate_limited is reported per user.
const user = (rate) => ({
  executor: 'constant-arrival-rate', rate: iterationRate(rate), timeUnit: '1s',
  duration: `${WARMUP + DURATION}s`, ...vus(rate),
});
const scenarios = { noisy: user(NOISY) };
for (const n of [1, 2, 3, 4]) scenarios[`normal-${n}`] = user(NORMAL);

const thresholds = gate('window:measured');
for (const u of Object.keys(scenarios)) thresholds[`rate_limited{user:${u},window:measured}`] = ['rate>=0'];

export const options = {
  userAgent: USER_AGENT,
  cloud: { name: 'lambda-concurrency-limit noisy-neighbour', ...CLOUD },
  thresholds,
  scenarios,
};

export default function () {
  if (!shouldSend()) return;
  const name = exec.scenario.name;
  const window = exec.instance.currentTestRunDuration / 1000 < WARMUP ? 'warmup' : 'measured';
  doRequest({ user: name, judged: name.startsWith('normal-'), tags: { window } });
}
```

- [ ] **Step 2: Verify every profile with `k6 inspect`**

Run, from `lambda-concurrency-limit/`:

```bash
for p in constant discovery spike noisy-neighbour; do k6 inspect infra/k6/tests/$p.js > /dev/null && echo "$p ok"; done
```

Expected: `constant ok`, `discovery ok`, `spike ok`, `noisy-neighbour ok`. A failure prints the
k6 parse or options error; fix it before going on.

- [ ] **Step 3: Check the scenario shapes**

Run: `k6 inspect -e RATE=55 infra/k6/tests/constant.js | grep -A3 '"measured"'`
Expected: `"rate": 220` (4 × 55).

Run: `k6 inspect infra/k6/tests/discovery.js | grep -c '"rps_'`
Expected: `11` (steps 10, 20 … 120).

- [ ] **Step 4: Run the whole suite**

Run: `cd service && node --test && npm run slo:check`
Expected: every test passes; `slo:check` exits 0.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add lambda-concurrency-limit/infra/k6/tests/constant.js lambda-concurrency-limit/infra/k6/tests/discovery.js lambda-concurrency-limit/infra/k6/tests/spike.js lambda-concurrency-limit/infra/k6/tests/noisy-neighbour.js
```
```bash
/usr/bin/git commit -m "test(lambda-concurrency-limit): add constant, discovery, spike and noisy-neighbour profiles"
```

---

## Self-review (done while writing)

- **Spec coverage.** Routes, responses, mix, CPU loop by iterations: Task 2. OTel collector with
  decouple last: Task 3. Additive seed, parameters, manifest: Task 4. `slo.yaml`, objectives,
  "429 is never a miss", judged users: Tasks 5 and 7. Erlang B, RCU, pinned values, CLI: Task 6.
  Thinning at 4×, profiles, per-user keys, `user` tag, spike head window: Tasks 7–8. Every runtime
  setting is an env var: Tasks 1, 2, 8. Out of scope here and owned by plan 2: Terraform, Grafana
  outputs of `generate-slo.js`, `deploy-service.sh`, `upload-k6.sh`, README, `loadtest.md`.
- **Deviations from the spec, deliberate:**
  - Class thresholds are **provisional numbers**, not open: k6 needs numbers to `inspect` and the
    pre-commit hook runs it. `slo.yaml` marks them `frozen: false`; plan 3 phase 0 freezes them by
    editing `slo.yaml` and running `npm run slo:generate` — configuration, not code.
  - The spec says each profile **records inter-arrival gaps** and checks CV ≈ 1. k6 VUs share no
    state, so a run cannot measure the gaps of all its requests. Task 7 pins the thinning
    statistics in a unit test instead, and the true CV of p = 0.25 thinning is √0.75 = 0.87, not 1.
  - The seed manifest lives **in the table** (marker item `_manifest`) as well as in the local file,
    so a re-created table is never skipped.
  - k6 load zone **Ashburn** (next to `us-east-1`), not the siblings' Frankfurt.
  - The service is **CommonJS** (see Global Constraints).
- **Placeholders:** none. **Type consistency:** `doRequest({ user, judged, tags })`, `gate(selector)`,
  `iterationRate`, `shouldSend`, `vus`, `classOf`, `seedItems(params, prev)` are used with the same
  names and shapes in every task.
