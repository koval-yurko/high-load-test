// src/cloudwatch.js
// Publishes event-loop utilization to CloudWatch as a high-resolution custom
// metric, which a 20-second alarm drives a step-scaling policy from
// (infra/main/alerts.tf).
//
// PutMetricData directly, NOT Embedded Metric Format through CloudWatch Logs:
// EMF is tempting -- the awslogs driver already ships stdout and needs no new
// IAM -- but log ingestion adds delay to the time from overload to the first
// scaling decision. The price is one IAM statement on the task role
// (infra/main/ecs.tf).
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { createEluSampler } from './elu.js';

export const METRIC_NAME = 'EventLoopUtilization';
// The alarm's dimensions must equal these EXACTLY -- a CloudWatch alarm on a
// metric with a different dimension set matches nothing and sits in
// INSUFFICIENT_DATA forever, silently.
export const DIMENSION_NAME = 'ServiceName';

/**
 * Dimensioned by service, never by task: every task publishes into the same
 * metric, so one alarm's Average aggregates the whole fleet and a task being
 * replaced does not orphan the alarm.
 *
 * Failures are swallowed and counted. A CloudWatch outage or throttle must cost
 * a datapoint, not the service -- this runs on a timer in the request process,
 * where an unhandled rejection would kill it.
 */
export function createEluPublisher({ client, namespace, serviceName, sampler, intervalMs = 10_000 }) {
  let failures = 0;
  let timer = null;

  async function publish() {
    try {
      await client.send(new PutMetricDataCommand({
        Namespace: namespace,
        MetricData: [{
          MetricName: METRIC_NAME,
          Dimensions: [{ Name: DIMENSION_NAME, Value: serviceName }],
          Value: sampler.sample(),
          Timestamp: new Date(),
          // 1 = high resolution. Without it CloudWatch stores one-minute
          // aggregates and a 20-second alarm period lapses into INSUFFICIENT_DATA.
          StorageResolution: 1,
        }],
      }));
    } catch {
      failures += 1;
    }
  }

  return {
    publish,
    start() {
      if (timer) return;
      // Not awaited: publish() never rejects, so there is nothing to handle. A
      // slow call may overlap the next tick; each tick samples its own window.
      timer = setInterval(publish, intervalMs);
      // Never the reason the process stays alive -- shutdown is SIGTERM's job.
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    get failures() { return failures; },
    get timer() { return timer; },
  };
}

/** Wiring for server.js. Only called when config.metricsNamespace is set. */
export function startEluPublisher(config) {
  const client = new CloudWatchClient({ region: config.region });
  const publisher = createEluPublisher({
    client,
    namespace: config.metricsNamespace,
    serviceName: config.serviceName,
    sampler: createEluSampler(),
    intervalMs: config.metricsIntervalMs,
  });
  publisher.start();
  return {
    publisher,
    stop() {
      publisher.stop();
      client.destroy();
    },
  };
}
