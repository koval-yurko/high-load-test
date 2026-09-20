// test/create-local-table.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { tableSpec, assertLocalEndpoint, createLocalTable } from '../scripts/create-local-table.js';
import { loadConfig } from '../src/config.js';

const ddb = mockClient(DynamoDBClient);
beforeEach(() => ddb.reset());

// The drift guard against infra/main/dynamodb.tf. That file declares hash_key = "pk",
// range_key = "sk", both type S; a local table with a different schema would serve every request
// the deployed one rejects, which is worse than not running locally at all.
test('the local table key schema matches the deployed table', () => {
  const spec = tableSpec('items');
  assert.deepEqual(spec.KeySchema, [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'sk', KeyType: 'RANGE' },
  ]);
  assert.deepEqual(spec.AttributeDefinitions, [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'sk', AttributeType: 'S' },
  ]);
});

test('the local table is on-demand, so no capacity number can be mistaken for the model', () => {
  const spec = tableSpec('items');
  assert.equal(spec.BillingMode, 'PAY_PER_REQUEST');
  assert.equal(spec.ProvisionedThroughput, undefined);
});

test('the table name comes from config, not a literal', () => {
  assert.equal(tableSpec('items-test').TableName, 'items-test');
});

// Without this guard the script would create a real table in whatever AWS account is in scope.
test('refuses to run when DYNAMO_ENDPOINT is unset', () => {
  assert.throws(
    () => assertLocalEndpoint(loadConfig({})),
    (err) => err.message.includes('DYNAMO_ENDPOINT'),
  );
});

test('refuses to run when DYNAMO_ENDPOINT is empty', () => {
  assert.throws(() => assertLocalEndpoint(loadConfig({ DYNAMO_ENDPOINT: '' })), /DYNAMO_ENDPOINT/);
});

test('accepts and returns a local endpoint', () => {
  const endpoint = assertLocalEndpoint(loadConfig({ DYNAMO_ENDPOINT: 'http://localhost:8000' }));
  assert.equal(endpoint, 'http://localhost:8000');
});

test('creating the table sends CreateTable once', async () => {
  ddb.on(CreateTableCommand).resolves({});
  assert.equal(await createLocalTable(new DynamoDBClient({}), 'items'), 'created');
  assert.equal(ddb.commandCalls(CreateTableCommand).length, 1);
});

// Re-running the documented local flow must be a no-op, not an error.
test('an existing table reports exists instead of throwing', async () => {
  const inUse = Object.assign(new Error('Table already exists'), { name: 'ResourceInUseException' });
  ddb.on(CreateTableCommand).rejects(inUse);
  assert.equal(await createLocalTable(new DynamoDBClient({}), 'items'), 'exists');
});

// Anything that is not "already there" is a real failure — a refused connection when the container
// is not running must reach the developer, not be swallowed as success.
test('any other error propagates', async () => {
  ddb.on(CreateTableCommand).rejects(Object.assign(new Error('connect ECONNREFUSED'), { name: 'ECONNREFUSED' }));
  await assert.rejects(createLocalTable(new DynamoDBClient({}), 'items'), /ECONNREFUSED/);
});
