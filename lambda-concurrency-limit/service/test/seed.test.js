'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mockClient } = require('aws-sdk-client-mock');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, BatchWriteCommand, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, seedParams, buildItem, itemSizeBytes, seedItems, chunk, writeAll } = require('../scripts/seed');

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

const SMALL_ENV = { FEEDS: '3', ITEMS_PER_FEED: '2', REPORTS: '2', ITEMS_PER_REPORT: '4', ITEM_BYTES: '512' };

test('run seeds an empty table from its own manifest read, then writes the manifest item', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
  try {
    ddb.on(GetCommand).resolves({});
    ddb.on(BatchWriteCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    const manifestFile = path.join(dir, 'seed-manifest.json');
    const out = await run(doc, 't', SMALL_ENV, { manifestFile, batchDelayMs: 0 });

    assert.equal(out.written, 14);
    assert.deepEqual(ddb.commandCalls(GetCommand)[0].args[0].input, { TableName: 't', Key: { pk: '_manifest', sk: '_manifest' } });
    const written = ddb.commandCalls(BatchWriteCommand).reduce((n, c) => n + c.args[0].input.RequestItems.t.length, 0);
    assert.equal(written, 14);
    const put = ddb.commandCalls(PutCommand);
    assert.equal(put.length, 1);
    assert.equal(put[0].args[0].input.Item.pk, '_manifest');
    assert.deepEqual(put[0].args[0].input.Item.params, seedParams(SMALL_ENV));
    assert.equal(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).items, 14);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run refuses a stored manifest it cannot follow before writing anything', async () => {
  const stored = { pk: '_manifest', sk: '_manifest', params: seedParams(SMALL_ENV) };
  for (const env of [{ ...SMALL_ENV, FEEDS: '2' }, { ...SMALL_ENV, ITEM_BYTES: '1024' }]) {
    ddb.reset();
    ddb.on(GetCommand).resolves({ Item: stored });
    ddb.on(BatchWriteCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    await assert.rejects(run(doc, 't', env, { manifestFile: os.devNull }), /re-create the table/);
    assert.equal(ddb.commandCalls(BatchWriteCommand).length, 0);
    assert.equal(ddb.commandCalls(PutCommand).length, 0);
  }
});
