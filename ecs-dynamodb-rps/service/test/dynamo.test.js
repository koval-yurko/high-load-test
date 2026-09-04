// test/dynamo.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { buildItem, itemSizeBytes, randomId, PAYLOAD_BYTES } from '../src/item.js';
import { createRepo } from '../src/dynamo.js';

const ddb = mockClient(DynamoDBDocumentClient);
const config = { region: 'eu-central-1', tableName: 'items', feedPageSize: 20 };
beforeEach(() => ddb.reset());

test('seeded item size stays inside the 900-1024 byte band', () => {
  const size = itemSizeBytes(buildItem({ pk: 'feed-00', sk: 'item-00' }));
  assert.ok(size >= 900 && size <= 1024, `seeded item is ${size} bytes`);
});

test('written item size stays inside the band', () => {
  const size = itemSizeBytes(buildItem({ pk: `w#${randomId()}`, sk: randomId(), expiresAt: 1893456000 }));
  assert.ok(size >= 900 && size <= 1024, `written item is ${size} bytes`);
});

test('a 20-item page rounds to exactly 5 read blocks', () => {
  const page = 20 * itemSizeBytes(buildItem({ pk: 'feed-00', sk: 'item-00' }));
  assert.equal(Math.ceil(page / 4096), 5, `page is ${page} bytes`);
});

test('randomId is 16 hex chars and does not repeat', () => {
  assert.match(randomId(), /^[0-9a-f]{16}$/);
  assert.notEqual(randomId(), randomId());
});

test('getItem returns the item', async () => {
  ddb.on(GetCommand).resolves({ Item: { pk: 'a', sk: 'b' } });
  assert.deepEqual(await createRepo(config).getItem('a', 'b'), { pk: 'a', sk: 'b' });
  const input = ddb.commandCalls(GetCommand)[0].args[0].input;
  assert.equal(input.TableName, 'items');
  assert.deepEqual(input.Key, { pk: 'a', sk: 'b' });
  assert.equal(input.ConsistentRead, false, 'eventual consistency halves the RCU cost — must not drift');
});

test('getItem returns null when absent', async () => {
  ddb.on(GetCommand).resolves({});
  assert.equal(await createRepo(config).getItem('a', 'b'), null);
  const input = ddb.commandCalls(GetCommand)[0].args[0].input;
  assert.equal(input.TableName, 'items');
  assert.deepEqual(input.Key, { pk: 'a', sk: 'b' });
  assert.equal(input.ConsistentRead, false, 'eventual consistency halves the RCU cost — must not drift');
});

test('putItem sends the item to the configured table', async () => {
  ddb.on(PutCommand).resolves({});
  const item = buildItem({ pk: 'w#1', sk: '2' });
  await createRepo(config).putItem(item);
  assert.equal(ddb.commandCalls(PutCommand)[0].args[0].input.TableName, 'items');
  assert.deepEqual(ddb.commandCalls(PutCommand)[0].args[0].input.Item, item);
});

test('queryFeed requests an eventually consistent read with the page limit', async () => {
  ddb.on(QueryCommand).resolves({ Items: [{ pk: 'feed-00', sk: 'item-00' }] });
  const items = await createRepo(config).queryFeed('feed-00', 20);
  assert.equal(items.length, 1);
  const input = ddb.commandCalls(QueryCommand)[0].args[0].input;
  assert.equal(input.TableName, 'items');
  assert.equal(input.ConsistentRead, false, 'eventual consistency halves the RCU cost — must not drift');
  assert.equal(input.Limit, 20);
  assert.equal(input.ExpressionAttributeValues[':pk'], 'feed-00');
});

test('queryFeed returns an empty array when the partition is empty', async () => {
  ddb.on(QueryCommand).resolves({});
  assert.deepEqual(await createRepo(config).queryFeed('nope', 20), []);
});
