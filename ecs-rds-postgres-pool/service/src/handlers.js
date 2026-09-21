// src/handlers.js
// Route shape forked from ecs-dynamodb-rps/service/src/handlers.js on
// 2026-09-20; the bodies are SQL and are this project's own.
import { buildPost } from './db.js';

// `template` is the route PATTERN, never the concrete path. It is the metric's
// http.route attribute and the key the collector maps to a latency class, so a
// raw path here would mint one time series per post id.
const ROUTES = [
  { name: 'health',     method: 'GET',  re: /^\/healthz$/,                 keys: [],     template: '/healthz' },
  { name: 'feed',       method: 'GET',  re: /^\/feeds\/([^/]+)\/posts$/,   keys: ['id'], template: '/feeds/:id/posts' },
  { name: 'getPost',    method: 'GET',  re: /^\/posts\/([^/]+)$/,          keys: ['id'], template: '/posts/:id' },
  { name: 'createPost', method: 'POST', re: /^\/posts$/,                   keys: [],     template: '/posts' },
  { name: 'report',     method: 'POST', re: /^\/reports$/,                 keys: [],     template: '/reports' },
];

/**
 * The single source of truth for which class a route belongs to. slo.yaml's
 * `classes` block and infra/grafana/classmap.json must agree with this, and
 * test/generate-slo.test.js asserts both directions, so a renamed route fails
 * the build instead of silently leaving traffic unclassified. /healthz is
 * deliberately absent: it carries no objective.
 */
export const ROUTE_CLASS = {
  getPost: 'fast',
  createPost: 'fast',
  feed: 'standard',
  report: 'heavy',
};

export function matchRoute(method, path) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    return { name: r.name, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])), template: r.template };
  }
  return null;
}

/** A positive integer, or null. Keeps a malformed id away from the pool. */
function toId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Real, deterministic work over the page: sort, then aggregate. */
function summarize(rows) {
  const sorted = [...rows].sort((a, b) => (a.score < b.score ? 1 : a.score > b.score ? -1 : 0));
  let bytes = 0;
  for (const r of sorted) bytes += r.body ? r.body.length : 0;
  return { count: sorted.length, bytes, top: sorted[0]?.id ?? null, feed: sorted[0]?.feed_name ?? null };
}

export function createHandlers({ repo, config }) {
  // Spread inserts across the seeded feeds rather than hammering one, so the
  // write path does not turn into a single-page hot spot that no production
  // workload would have.
  const someFeed = () => 1 + Math.floor(Math.random() * config.seedFeeds);

  return {
    async health() { return { status: 200, body: { ok: true } }; },

    async getPost({ params, timer }) {
      const id = toId(params.id);
      if (id === null) return { status: 400, body: { error: 'id must be a positive integer' } };
      const post = await timer.measure('db', () => repo.getPost(id));
      return post ? { status: 200, body: post } : { status: 404, body: { error: 'not found' } };
    },

    async createPost({ timer }) {
      const post = buildPost(someFeed());
      const created = await timer.measure('db', () => repo.createPost(post));
      return { status: 201, body: { id: created.id, feedId: post.feedId } };
    },

    async feed({ params, timer }) {
      const id = toId(params.id);
      if (id === null) return { status: 400, body: { error: 'id must be a positive integer' } };
      const rows = await timer.measure('db', () => repo.feedPage(id, config.feedPageSize));
      const body = timer.measureSync('cpu', () => summarize(rows));
      return { status: 200, body };
    },

    /**
     * The heavy route and the longest hold: ONE data-modifying CTE that scans
     * config.reportScanRows rows, aggregates them and inserts a row. One
     * statement, therefore one pool checkout -- the capacity model in the spec
     * assumes exactly that, and test/db.test.js asserts it.
     */
    async report({ body, timer }) {
      const feedId = toId(body?.feedId) ?? someFeed();
      const post = buildPost(feedId);
      const out = await timer.measure('db', () => repo.report({
        scanRows: config.reportScanRows,
        sleepMs: config.reportSleepMs,
        post,
      }));
      return {
        status: 200,
        body: { feedId, scanned: out.n, bytes: out.bytes, feeds: out.feeds, recordId: out.recordId },
      };
    },
  };
}
