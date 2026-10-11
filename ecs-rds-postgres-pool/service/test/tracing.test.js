import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ignoreIncoming, serverRequestHook, httpOptions, pgOptions, BATCH } from '../src/tracing-options.js';

const fakeSpan = () => {
  const s = { name: null, attrs: {} };
  s.updateName = (n) => { s.name = n; };
  s.setAttribute = (k, v) => { s.attrs[k] = v; };
  return s;
};

test('the request hook names the span and sets route and class', () => {
  const s = fakeSpan();
  serverRequestHook(s, { method: 'POST', url: '/reports' });
  assert.equal(s.name, 'POST /reports');
  assert.deepEqual(s.attrs, { 'http.route': '/reports', class: 'heavy' });
});

test('the template, not the concrete id, is what is recorded', () => {
  const s = fakeSpan();
  serverRequestHook(s, { method: 'GET', url: '/posts/123?x=1' });
  assert.equal(s.attrs['http.route'], '/posts/:id');
  assert.equal(s.attrs.class, 'fast');
});

test('an unknown route, a missing url or a client request never throws', () => {
  for (const req of [{ method: 'GET', url: '/nope' }, { method: 'GET' }, {}, { method: 'GET', url: 42 }]) {
    const s = fakeSpan();
    assert.doesNotThrow(() => serverRequestHook(s, req));
    assert.deepEqual(s.attrs, {});
  }
});

test('/healthz is ignored, with or without a query string; real routes are not', () => {
  assert.equal(ignoreIncoming({ url: '/healthz' }), true);
  assert.equal(ignoreIncoming({ url: '/healthz?x=1' }), true);
  assert.equal(ignoreIncoming({ url: '/posts/1' }), false);
});

test('outgoing http is never traced', () => {
  assert.equal(httpOptions().ignoreOutgoingRequestHook(), true);
});

test('SQL parameter values are never recorded', () => {
  assert.equal(pgOptions.enhancedDatabaseReporting, false);
});

test('the batch queue is sized for 100% sampling under load', () => {
  assert.ok(BATCH.maxQueueSize >= 8192);
});

const preload = fileURLToPath(new URL('../src/tracing.js', import.meta.url));
const run = (env) => spawnSync(process.execPath, ['--import', preload, '-e', 'setTimeout(() => {}, 300)'], {
  env: { PATH: process.env.PATH, DATABASE_URL: 'postgresql://u:p@localhost:5432/d', ...env },
  encoding: 'utf8',
  timeout: 20_000,
});

test('with OTLP_ENDPOINT unset the preload is a clean no-op', () => {
  const r = run({});
  assert.equal(r.status, 0, r.stderr);
});

test('an unreachable collector does not crash the process', () => {
  const r = run({ OTLP_ENDPOINT: 'http://127.0.0.1:1' });
  assert.equal(r.status, 0, r.stderr);
});

test('a bad TRACE_SAMPLE_RATIO fails the boot by name', () => {
  const r = run({ OTLP_ENDPOINT: 'http://127.0.0.1:1', TRACE_SAMPLE_RATIO: '2' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TRACE_SAMPLE_RATIO/);
});
