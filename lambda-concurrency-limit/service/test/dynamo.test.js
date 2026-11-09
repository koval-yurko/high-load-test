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
