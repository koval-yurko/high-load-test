// src/routes.js
// The route table and its latency classes. Split out of handlers.js so the
// tracing preload can name spans by route WITHOUT importing handlers.js, which
// pulls in db.js, Prisma and pg before the instrumentation is registered.
// This file must stay import-free (test/routes.test.js asserts it).
// handlers.js re-exports both names; nothing else changes.

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
