import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchRoute, ROUTE_CLASS } from '../src/routes.js';
import * as handlers from '../src/handlers.js';

test('matchRoute returns name, params and the template, not the raw path', () => {
  assert.deepEqual(matchRoute('GET', '/posts/7'), { name: 'getPost', params: { id: '7' }, template: '/posts/:id' });
  assert.deepEqual(matchRoute('POST', '/reports'), { name: 'report', params: {}, template: '/reports' });
});

test('an unknown route or wrong method is null', () => {
  assert.equal(matchRoute('GET', '/nope'), null);
  assert.equal(matchRoute('DELETE', '/posts/7'), null);
});

test('handlers.js re-exports the same table, so there is one source of truth', () => {
  assert.equal(handlers.matchRoute, matchRoute);
  assert.equal(handlers.ROUTE_CLASS, ROUTE_CLASS);
});

test('/healthz carries no class', () => {
  assert.equal(ROUTE_CLASS.health, undefined);
});

test('routes.js imports nothing, so the tracing preload can load it before pg', () => {
  const src = readFileSync(new URL('../src/routes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
});
