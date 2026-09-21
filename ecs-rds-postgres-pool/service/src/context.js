// src/context.js
// The request's identity, reachable from anywhere inside its async tree.
//
// This exists for ONE reason: the pool's checkout happens deep inside Prisma's
// call stack, with no parameter to thread a route through. Without this, a
// pool-wait histogram is process-global and can say a queue existed but not
// whose requests were in it -- which is the question this project exists to
// answer (spec decision S1).
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** `fn`'s return value is passed through, so callers can await it. */
export function runInRequestContext(ctx, fn) {
  return storage.run(ctx, fn);
}

/** undefined outside a request -- the pool still works, it just cannot label. */
export function currentRequest() {
  return storage.getStore();
}
