// test/integration.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { createRepo } from '../src/dynamo.js';
import { createHandlers } from '../src/handlers.js';
import { createServer } from '../src/server.js';
import { seedItems, chunk } from '../scripts/seed.js';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

// Requires a real DynamoDB Local endpoint. Skipped by default so a bare `npm test` is green and
// honestly reports these as skipped rather than either failing (no DynamoDB Local available) or
// silently passing. `npm run test:integration` sets DYNAMO_ENDPOINT and runs them for real.
describe('integration', { skip: !process.env.DYNAMO_ENDPOINT && 'set DYNAMO_ENDPOINT to run against DynamoDB Local' }, () => {
  const config = {
    region: 'eu-central-1', tableName: 'items-test', feedPageSize: 20,
    pbkdf2Iterations: 50, itemTtlSeconds: 3600, dynamoEndpoint: process.env.DYNAMO_ENDPOINT,
  };
  process.env.AWS_ACCESS_KEY_ID ||= 'local';
  process.env.AWS_SECRET_ACCESS_KEY ||= 'local';

  let server, base, repo;
  const url = (p) => `http://localhost:${server.address().port}${p}`;

  before(async () => {
    base = new DynamoDBClient({ region: config.region, endpoint: config.dynamoEndpoint });
    await base.send(new CreateTableCommand({
      TableName: config.tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    })).catch((e) => { if (e.name !== 'ResourceInUseException') throw e; });

    const doc = DynamoDBDocumentClient.from(base);
    for (const g of chunk(seedItems(), 25))
      await doc.send(new BatchWriteCommand({ RequestItems: { [config.tableName]: g.map((Item) => ({ PutRequest: { Item } })) } }));

    repo = createRepo(config);
    server = createServer({ handlers: createHandlers({ repo, config }) });
    await new Promise((r) => server.listen(0, r));
  });

  after(async () => { server.close(); repo.destroy(); base.destroy(); });

  test('no response carries a Server-Timing header', async () => {
    for (const [path, init] of [
      ['/healthz', undefined],
      ['/feeds/feed-00', undefined],
      ['/items/feed-00/item-00', undefined],
      ['/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
      ['/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pk":"feed-00"}' }],
    ]) {
      const res = await fetch(url(path), init);
      assert.equal(res.headers.get('server-timing'), null, `${path} still emits Server-Timing`);
    }
  });

  test('missing item 404s', async () => {
    assert.equal((await fetch(url('/items/feed-07/item-99'))).status, 404);
  });

  test('putItem creates a record under the w# prefix', async () => {
    const res = await fetch(url('/items'), { method: 'POST', body: '{}' });
    assert.equal(res.status, 201);
    assert.match((await res.json()).pk, /^w#/);
  });

  test('report queries, hashes and writes', async () => {
    const res = await fetch(url('/reports'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pk: 'feed-12' }),
    });
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.count, 20);
    assert.match(b.digest, /^[0-9a-f]{16}$/);
  });

  test('a write never lands in a seeded partition', async () => {
    await fetch(url('/items'), { method: 'POST', body: '{}' });
    assert.equal((await fetch(url('/feeds/feed-12'))).status, 200);
    assert.equal((await (await fetch(url('/feeds/feed-12'))).json()).count, 20, 'feed page size must be unchanged by writes');
  });

  test('stats is not a route', async () => {
    assert.equal((await fetch(url('/stats'))).status, 404);
  });

  test('healthz still answers -- the ALB target group health-checks it', async () => {
    assert.equal((await fetch(url('/healthz'))).status, 200);
  });

  test('unknown route 404s', async () => {
    assert.equal((await fetch(url('/nope'))).status, 404);
  });

  test('a served request produces one exponential-histogram datapoint per route', async (t) => {
    const { AggregationTemporality, DataPointType, MetricReader } = await import('@opentelemetry/sdk-metrics');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const { REQUEST_DURATION, bindHistogram, buildMeterProvider } = await import('../src/otel.js');

    class TestReader extends MetricReader {
      selectAggregationTemporality() { return AggregationTemporality.CUMULATIVE; }
      async onForceFlush() {}
      async onShutdown() {}
    }
    const reader = new TestReader();
    const provider = buildMeterProvider({
      resource: resourceFromAttributes({ 'service.name': 'itest', 'service.instance.id': 'itest-1' }),
      readers: [reader],
    });
    bindHistogram(provider);
    t.after(() => provider.shutdown());

    await fetch(url('/healthz'));
    await fetch(url('/items/feed-00/item-00'));
    await fetch(url('/nope/whatever'));

    const { resourceMetrics } = await reader.collect();
    const metric = resourceMetrics.scopeMetrics[0].metrics.find((m) => m.descriptor.name === REQUEST_DURATION);
    const routes = metric.dataPoints.map((p) => p.attributes['http.route']).sort();

    assert.equal(metric.dataPointType, DataPointType.EXPONENTIAL_HISTOGRAM);
    // /healthz IS emitted -- it is excluded in the SLO QUERY, not at the source
    // (spec S15). 'unmatched' proves a scanner cannot mint series from raw paths.
    assert.deepEqual(routes, ['/healthz', '/items/:pk/:sk', 'unmatched']);
  });
});
