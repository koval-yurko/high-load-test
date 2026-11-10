'use strict';
const { loadConfig } = require('./config');
const { createRepo } = require('./dynamo');
const { burn } = require('./cpu');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const NOT_FOUND = json(404, { error: 'not found' });

function createHandler({ repo, config }) {
  // Keyed on API Gateway's resource template, so there is no path parsing to get wrong.
  const routes = {
    'GET /items/{pk}/{sk}': async ({ pk, sk }) => {
      const item = await repo.getItem(pk, sk);
      return item ? json(200, item) : NOT_FOUND;
    },
    'GET /feeds/{pk}': async ({ pk }) => {
      const items = await repo.queryAll(pk);
      return items.length ? json(200, { items }) : NOT_FOUND;
    },
    'GET /reports/{pk}': async ({ pk }) => {
      const items = await repo.queryAll(pk);
      if (!items.length) return NOT_FOUND;
      return json(200, { count: items.length, digest: burn(config.heavyCpuIterations, pk) });
    },
  };

  return async (event) => {
    // /public/* is the keyless copy of each route (tiered rate limits spec); same handlers.
    const resource = event.resource.replace(/^\/public(?=\/)/, '');
    const route = routes[`${event.httpMethod} ${resource}`];
    if (!route) return NOT_FOUND;
    try {
      return await route(event.pathParameters ?? {});
    } catch (err) {
      console.error(JSON.stringify({ msg: 'request failed', route: event.resource, error: err.name }));
      return json(500, { error: 'internal' });
    }
  };
}

// Built once per execution environment and reused by every warm invocation.
let handle;
exports.handler = async (event) => {
  if (!handle) {
    const config = loadConfig();
    handle = createHandler({ repo: createRepo(config), config });
  }
  return handle(event);
};
exports.createHandler = createHandler;
