// test/seed.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { seedItems, chunk, writeAll, PARTITIONS, ITEMS_PER_PARTITION } from '../scripts/seed.js';
import { itemSizeBytes } from '../src/item.js';

const ddb = mockClient(DynamoDBDocumentClient);
const noSleep = async () => {};
beforeEach(() => ddb.reset());

test('produces exactly 1000 items', () => {
  assert.equal(seedItems().length, PARTITIONS * ITEMS_PER_PARTITION);
  assert.equal(seedItems().length, 1000);
});

test('keys are zero-padded and deterministic', () => {
  const items = seedItems();
  assert.equal(items[0].pk, 'feed-00');
  assert.equal(items[0].sk, 'item-00');
  assert.equal(items.at(-1).pk, 'feed-49');
  assert.equal(items.at(-1).sk, 'item-19');
  assert.deepEqual(seedItems(), items);
});

test('every partition holds exactly the page size', () => {
  const byPk = new Map();
  for (const it of seedItems()) byPk.set(it.pk, (byPk.get(it.pk) ?? 0) + 1);
  assert.equal(byPk.size, PARTITIONS);
  for (const [pk, n] of byPk) assert.equal(n, ITEMS_PER_PARTITION, `${pk} has ${n}`);
});

test('seeded items carry no ttl', () => {
  assert.equal(seedItems()[0].expires_at, undefined);
});

test('every item sits inside the 900-1024 byte band', () => {
  for (const it of seedItems()) {
    const size = itemSizeBytes(it);
    assert.ok(size >= 900 && size <= 1024, `${it.pk}/${it.sk} is ${size} bytes`);
  }
});

test('chunk splits into BatchWriteItem-legal groups of 25', () => {
  const groups = chunk(seedItems(), 25);
  assert.equal(groups.length, 40);
  for (const g of groups) assert.ok(g.length <= 25);
  assert.equal(groups.flat().length, 1000);
});

test('writeAll writes all 1000 items in 40 BatchWriteCommand calls when nothing is throttled', async () => {
  ddb.on(BatchWriteCommand).resolves({});
  const items = seedItems();
  const written = await writeAll(ddb, 'items', items, { sleep: noSleep });
  assert.equal(written, 1000);
  assert.equal(ddb.commandCalls(BatchWriteCommand).length, 40);
});

test('writeAll retries when UnprocessedItems comes back, and completes', async () => {
  const items = seedItems().slice(0, 25);
  const stragglers = items.slice(0, 3).map((Item) => ({ PutRequest: { Item } }));
  ddb
    .on(BatchWriteCommand)
    .resolvesOnce({ UnprocessedItems: { items: stragglers } })
    .resolves({});

  const written = await writeAll(ddb, 'items', items, { sleep: noSleep });

  assert.equal(written, 25);
  assert.equal(ddb.commandCalls(BatchWriteCommand).length, 2, 'expected exactly one retry');
  const retryInput = ddb.commandCalls(BatchWriteCommand)[1].args[0].input;
  assert.equal(retryInput.RequestItems.items.length, 3, 'retry should only resend the stragglers');
});

test('writeAll throws naming the unwritten count when items never stop being throttled', async () => {
  const items = seedItems().slice(0, 25);
  ddb.on(BatchWriteCommand).callsFake((input) => ({
    UnprocessedItems: { items: input.RequestItems.items },
  }));

  await assert.rejects(
    writeAll(ddb, 'items', items, { attempts: 3, sleep: noSleep }),
    (err) => {
      assert.match(err.message, /25/);
      assert.match(err.message, /feed-00/);
      return true;
    },
  );
  assert.equal(ddb.commandCalls(BatchWriteCommand).length, 3, 'should stop after the configured attempts');
});

function throttleError(name = 'ProvisionedThroughputExceededException') {
  const err = new Error(name);
  err.name = name;
  err.$metadata = { httpStatusCode: 400 };
  return err;
}

test('writeAll retries a thrown ProvisionedThroughputExceededException and completes', async () => {
  const items = seedItems().slice(0, 25);
  ddb
    .on(BatchWriteCommand)
    .rejectsOnce(throttleError('ProvisionedThroughputExceededException'))
    .resolves({});

  const written = await writeAll(ddb, 'items', items, { sleep: noSleep });

  assert.equal(written, 25);
  assert.equal(ddb.commandCalls(BatchWriteCommand).length, 2, 'expected exactly one retry');
  const retryInput = ddb.commandCalls(BatchWriteCommand)[1].args[0].input;
  assert.equal(retryInput.RequestItems.items.length, 25, 'retry should resend the whole rejected batch');
});

test('writeAll re-throws a non-throttling error immediately without retrying', async () => {
  const items = seedItems().slice(0, 25);
  const validationError = new Error('ValidationException');
  validationError.name = 'ValidationException';
  validationError.$metadata = { httpStatusCode: 400 };
  ddb.on(BatchWriteCommand).rejects(validationError);

  await assert.rejects(
    writeAll(ddb, 'items', items, { sleep: noSleep }),
    (err) => {
      assert.equal(err.name, 'ValidationException');
      return true;
    },
  );
  assert.equal(ddb.commandCalls(BatchWriteCommand).length, 1, 'a non-throttling error must not be retried');
});

test('writeAll throws naming the unwritten count when a thrown throttling error never stops', async () => {
  const items = seedItems().slice(0, 25);
  ddb.on(BatchWriteCommand).rejects(throttleError('ThrottlingException'));

  await assert.rejects(
    writeAll(ddb, 'items', items, { attempts: 3, sleep: noSleep }),
    (err) => {
      assert.match(err.message, /25/);
      assert.match(err.message, /feed-00/);
      return true;
    },
  );
  assert.equal(ddb.commandCalls(BatchWriteCommand).length, 3, 'should stop after the configured attempts');
});
