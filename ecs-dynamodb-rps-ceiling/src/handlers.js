// src/handlers.js
import { burn } from './cpu.js';
import { snapshot } from './stats.js';
import { buildItem, randomId } from './item.js';

const ROUTES = [
  { name: 'health',  method: 'GET',  re: /^\/healthz$/,                 keys: [] },
  { name: 'stats',   method: 'GET',  re: /^\/stats$/,                   keys: [] },
  { name: 'feed',    method: 'GET',  re: /^\/feeds\/([^/]+)$/,          keys: ['pk'] },
  { name: 'getItem', method: 'GET',  re: /^\/items\/([^/]+)\/([^/]+)$/, keys: ['pk', 'sk'] },
  { name: 'putItem', method: 'POST', re: /^\/items$/,                   keys: [] },
  { name: 'report',  method: 'POST', re: /^\/reports$/,                 keys: [] },
];

export function matchRoute(method, path) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    return { name: r.name, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])) };
  }
  return null;
}

/** Real, deterministic work over the page: sort, then aggregate. */
function summarize(items) {
  const sorted = [...items].sort((a, b) => (a.sk < b.sk ? 1 : a.sk > b.sk ? -1 : 0));
  let bytes = 0;
  for (const it of sorted) bytes += it.payload ? it.payload.length : 0;
  return { count: sorted.length, bytes, first: sorted[0]?.sk ?? null, last: sorted.at(-1)?.sk ?? null };
}

export function createHandlers({ repo, config }) {
  const newRecord = () => buildItem({
    pk: `w#${randomId()}`,
    sk: randomId(),
    expiresAt: Math.floor(Date.now() / 1000) + config.itemTtlSeconds,
  });

  return {
    async health() { return { status: 200, body: { ok: true } }; },

    async stats() { return { status: 200, body: snapshot({ reset: true }) }; },

    async getItem({ params, timer }) {
      const item = await timer.measure('db', () => repo.getItem(params.pk, params.sk));
      return item ? { status: 200, body: item } : { status: 404, body: { error: 'not found' } };
    },

    async putItem({ timer }) {
      const record = newRecord();
      await timer.measure('db', () => repo.putItem(record));
      return { status: 201, body: record };
    },

    async feed({ params, timer }) {
      const items = await timer.measure('db', () => repo.queryFeed(params.pk, config.feedPageSize));
      const body = timer.measureSync('cpu', () => summarize(items));
      return { status: 200, body };
    },

    async report({ body, timer }) {
      const pk = body?.pk ?? 'feed-00';
      const items = await timer.measure('db', () => repo.queryFeed(pk, config.feedPageSize));
      const digest = timer.measureSync('cpu', () => burn(config.pbkdf2Iterations, `${pk}:${items.length}`));
      const record = newRecord();
      await timer.measure('db', () => repo.putItem(record));
      return { status: 200, body: { pk, count: items.length, digest, recordId: record.sk } };
    },
  };
}
