// test/cloudwatch.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { mockClient } from 'aws-sdk-client-mock';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { createEluPublisher, METRIC_NAME, DIMENSION_NAME } from '../src/cloudwatch.js';

const cw = mockClient(CloudWatchClient);
const fixedSampler = (value) => ({ sample: () => value });
const base = () => ({
  client: new CloudWatchClient({ region: 'eu-central-1' }),
  namespace: 'ecs-dynamodb-rps',
  serviceName: 'ecs-dynamodb-rps',
  sampler: fixedSampler(0.42),
});

let publisher;
beforeEach(() => cw.reset());
afterEach(() => publisher?.stop());

test('publishes one high-resolution ELU datapoint dimensioned by service, not task', async () => {
  cw.on(PutMetricDataCommand).resolves({});
  publisher = createEluPublisher(base());
  await publisher.publish();

  const calls = cw.commandCalls(PutMetricDataCommand);
  assert.equal(calls.length, 1);
  const input = calls[0].args[0].input;
  assert.equal(input.Namespace, 'ecs-dynamodb-rps');
  assert.equal(input.MetricData.length, 1);
  const [datum] = input.MetricData;
  assert.equal(datum.MetricName, 'EventLoopUtilization');
  assert.equal(METRIC_NAME, 'EventLoopUtilization');
  assert.equal(datum.Value, 0.42);
  assert.equal(datum.StorageResolution, 1, 'sub-minute alarm periods need StorageResolution 1');
  // Exactly one dimension, and it is the service. A task-id dimension would make
  // every task its own metric, and a single alarm could not aggregate them.
  assert.deepEqual(datum.Dimensions, [{ Name: 'ServiceName', Value: 'ecs-dynamodb-rps' }]);
  assert.equal(DIMENSION_NAME, 'ServiceName');
  assert.ok(datum.Timestamp instanceof Date);
});

test('a PutMetricData failure is swallowed and counted, never thrown', async () => {
  cw.on(PutMetricDataCommand).rejects(new Error('ThrottlingException'));
  publisher = createEluPublisher(base());
  await assert.doesNotReject(publisher.publish());
  await assert.doesNotReject(publisher.publish());
  assert.equal(publisher.failures, 2);
});

test('a sampler that throws is counted, not thrown', async () => {
  cw.on(PutMetricDataCommand).resolves({});
  publisher = createEluPublisher({ ...base(), sampler: { sample() { throw new Error('boom'); } } });
  await assert.doesNotReject(publisher.publish());
  assert.equal(publisher.failures, 1);
  assert.equal(cw.commandCalls(PutMetricDataCommand).length, 0);
});

test('the interval publishes, failures on the timer path raise no unhandled rejection, and stop() stops it', async () => {
  cw.on(PutMetricDataCommand).rejects(new Error('network down'));
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    publisher = createEluPublisher({ ...base(), intervalMs: 10 });
    publisher.start();
    await sleep(80);
    publisher.stop();
    const sent = cw.commandCalls(PutMetricDataCommand).length;
    assert.ok(sent >= 2, `expected the timer to publish repeatedly, sent ${sent}`);
    await sleep(20);                 // let in-flight rejections settle
    assert.ok(publisher.failures >= 2, `failures counted: ${publisher.failures}`);
    const settled = cw.commandCalls(PutMetricDataCommand).length;
    await sleep(60);
    assert.equal(cw.commandCalls(PutMetricDataCommand).length, settled, 'no publishes after stop()');
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('the timer is unref()d so it never holds the process open', () => {
  cw.on(PutMetricDataCommand).resolves({});
  publisher = createEluPublisher({ ...base(), intervalMs: 10_000 });
  publisher.start();
  assert.equal(publisher.timer.hasRef(), false);
  publisher.stop();
  assert.equal(publisher.timer, null);
});

test('start() twice does not create a second timer', () => {
  publisher = createEluPublisher({ ...base(), intervalMs: 10_000 });
  publisher.start();
  const first = publisher.timer;
  publisher.start();
  assert.equal(publisher.timer, first);
});
