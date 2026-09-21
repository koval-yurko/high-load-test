import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server.js';

const noopTelemetry = { recordRequest() {}, recordPoolWait() {}, async shutdown() {} };

function start(handlers) {
  const server = createServer({ handlers, telemetry: noopTelemetry, config: { port: 0 } });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const handlers = {
  async health() { return { status: 200, body: { ok: true } }; },
  async getPost() { return { status: 200, body: { id: 1 } }; },
  async createPost() { return { status: 201, body: { id: 2 } }; },
  async feed() { return { status: 200, body: { count: 0 } }; },
  async report() { return { status: 200, body: { scanned: 0 } }; },
};

test('healthz answers 200', async () => {
  const { server, url } = await start(handlers);
  const res = await fetch(`${url}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  server.close();
});

test('an unknown path is 404 and is not recorded as a route', async () => {
  const seen = [];
  const server = createServer({
    handlers,
    telemetry: { ...noopTelemetry, recordRequest: (r) => seen.push(r) },
    config: { port: 0 },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(res.status, 404);
  assert.equal(seen.length, 0, 'an unmatched path must not mint a time series');
  server.close();
});

test('a handler that throws becomes a 500, and the request is still recorded', async () => {
  const seen = [];
  const server = createServer({
    handlers: { ...handlers, feed: async () => { throw new Error('boom'); } },
    telemetry: { ...noopTelemetry, recordRequest: (r) => seen.push(r) },
    config: { port: 0 },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/feeds/3/posts`);
  assert.equal(res.status, 500);
  assert.equal(seen[0].status, 500);
  assert.equal(seen[0].route, '/feeds/:id/posts');
  server.close();
});

test('a recorded request carries the route template and its class', async () => {
  const seen = [];
  const server = createServer({
    handlers,
    telemetry: { ...noopTelemetry, recordRequest: (r) => seen.push(r) },
    config: { port: 0 },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await fetch(`http://127.0.0.1:${port}/posts/42`);
  assert.equal(seen[0].route, '/posts/:id');
  assert.equal(seen[0].class, 'fast');
  assert.ok(seen[0].seconds >= 0);
  server.close();
});

test('a throw outside the handler is contained, not an unhandled rejection', async () => {
  // recordRequest, send, matchRoute and new URL all sit outside the inner try,
  // and the request callback is async: without the outer guard a throw there is
  // an unhandled rejection, which Node 22 answers by exiting the process. In a
  // load run that is a dead task and a hole in the window, not a 5xx. The
  // second request is the assertion that the server is still alive.
  const server = createServer({
    handlers,
    telemetry: { ...noopTelemetry, recordRequest: () => { throw new Error('recorder exploded'); } },
    config: { port: 0 },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const first = await fetch(`http://127.0.0.1:${port}/posts/42`);
  assert.equal(first.status, 200, 'the response is sent before the recorder runs');
  const second = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(second.status, 200, 'the process must survive to serve the next request');
  server.close();
});

// R-guard: reaching the outer catch with headersSent AND writableEnded true --
// the realistic trigger is recordRequest throwing after send() -- must not
// destroy the socket. The response was already fully written; destroying it
// risks truncating buffered bytes and, worse, kills a keep-alive connection
// the load generator may be about to reuse. This drives the same
// throwing-recorder shape as the test above, over a real keep-alive agent, so
// the assertion is about the actual socket rather than just the status code.
test('a completed response is not destroyed when recordRequest throws after send', async () => {
  const server = createServer({
    handlers,
    telemetry: { ...noopTelemetry, recordRequest: () => { throw new Error('recorder exploded'); } },
    config: { port: 0 },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const get = (path) => new Promise((resolve, reject) => {
    let socket;
    const req = http.request({ host: '127.0.0.1', port, path, agent }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, socket, body: data }));
    });
    // Captured off the REQUEST, not the response: res.socket is nulled out by
    // the time 'end' fires, but the socket itself (and whether the server
    // destroyed it) is what this test needs to inspect.
    req.on('socket', (s) => { socket = s; });
    req.on('error', reject);
    req.end();
  });

  try {
    const first = await get('/posts/42');
    assert.equal(first.status, 200);
    assert.deepEqual(JSON.parse(first.body), { id: 1 }, 'the full, untruncated body must arrive');

    // Let the keep-alive bookkeeping (and any destroy(), if the bug regresses) settle.
    await new Promise((r) => setImmediate(r));
    assert.equal(first.socket.destroyed, false,
      'the socket must survive a recorder that throws after the response already ended');

    const second = await get('/healthz');
    assert.equal(second.status, 200);
    assert.equal(second.socket, first.socket, 'the connection must be reused, not reopened');
  } finally {
    agent.destroy();
    server.close();
  }
});

test('malformed JSON on a POST is a 400, not a 500', async () => {
  const { server, url } = await start(handlers);
  const res = await fetch(`${url}/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  server.close();
});

// R20: an oversized body must not be accepted -- an unbounded body on a
// public-internet-facing load balancer is a memory-exhaustion path. Mirrors
// the sibling's 16 KB cap; the throw lands in the existing catch and becomes
// a 500, not an invented 413 this project's SLI has no treatment for.
test('a request body over the 16 KB cap is rejected, not buffered without limit', async () => {
  const { server, url } = await start(handlers);
  const oversized = JSON.stringify({ feedId: 1, body: 'x'.repeat(20 * 1024) });
  const res = await fetch(`${url}/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: oversized,
  });
  assert.equal(res.status, 500);
  server.close();
});
