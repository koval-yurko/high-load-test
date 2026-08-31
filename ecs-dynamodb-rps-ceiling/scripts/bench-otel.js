// Isolates the cost of the metric record itself: no HTTP, no DynamoDB, no GC
// pressure from anything else. The absolute number is machine-specific and
// meaningless on its own -- the RATIO to the 250us/request budget is the point,
// and Task 13 re-measures on real Fargate hardware.
import { AggregationTemporality, MetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { bindHistogram, buildMeterProvider, recordRequest } from '../src/otel.js';

class NullReader extends MetricReader {
  selectAggregationTemporality() { return AggregationTemporality.CUMULATIVE; }
  async onForceFlush() {}
  async onShutdown() {}
}

const N = Number(process.env.N ?? 200_000);
const ROUTES = ['/items/:pk/:sk', '/items', '/feeds/:pk', '/reports'];

const provider = buildMeterProvider({
  resource: resourceFromAttributes({ 'service.name': 'bench', 'service.instance.id': 'bench-1' }),
  readers: [new NullReader()],
});
bindHistogram(provider);

// Warm up so the JIT has settled before the measured window.
for (let i = 0; i < 20_000; i++) recordRequest({ route: ROUTES[i % 4], method: 'GET', status: 200, durationSeconds: 0.004 });

const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) recordRequest({ route: ROUTES[i % 4], method: 'GET', status: 200, durationSeconds: 0.004 });
const t1 = process.hrtime.bigint();

const perCallUs = Number(t1 - t0) / N / 1000;
console.log(JSON.stringify({
  iterations: N,
  perCallMicroseconds: Number(perCallUs.toFixed(3)),
  // 0.25 vCPU at 1000 RPS is 250us per request, all in.
  percentOfBudgetAt1000rps: Number(((perCallUs / 250) * 100).toFixed(2)),
}));
await provider.shutdown();
