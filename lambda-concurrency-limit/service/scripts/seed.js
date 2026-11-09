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

/**
 * The seed itself, against an injected document client. The manifest is read from the TABLE,
 * not the local file: a re-created table must be seeded in full even if an old
 * seed-manifest.json is still on disk. A stored manifest that the new params cannot follow
 * throws before any write.
 */
async function run(doc, table, env, { manifestFile = MANIFEST_FILE, batchDelayMs = 0, onProgress } = {}) {
  const params = seedParams(env);
  const prev = (await doc.send(new GetCommand({ TableName: table, Key: MANIFEST_KEY }))).Item?.params ?? null;
  const items = seedItems(params, prev);
  await writeAll(doc, table, items, { batchDelayMs, onProgress });

  const total = params.feeds * params.itemsPerFeed + params.reports * params.itemsPerReport;
  const manifest = { table, params, items: total, bytes: total * params.itemBytes, seededAt: new Date().toISOString() };
  await doc.send(new PutCommand({ TableName: table, Item: { ...MANIFEST_KEY, ...manifest } }));
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { written: items.length, total, manifestFile };
}

async function main() {
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error('TABLE_NAME is required (terraform -chdir=infra/main output -raw table_name)');
  // The seed is not the measured path, so it may retry harder than the service.
  const base = new DynamoDBClient({ maxAttempts: 8 });
  const doc = DynamoDBDocumentClient.from(base);
  const { written, total, manifestFile } = await run(doc, table, process.env, {
    batchDelayMs: Number(process.env.SEED_BATCH_DELAY_MS || 0),
    onProgress: (n, all) => process.stdout.write(`\rseeded ${n}/${all}`),
  });
  console.log(`\nwrote ${written} new item(s); table holds ${total}; manifest ${manifestFile}`);
  base.destroy();
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { run, seedParams, buildItem, itemSizeBytes, seedItems, chunk, writeAll };
