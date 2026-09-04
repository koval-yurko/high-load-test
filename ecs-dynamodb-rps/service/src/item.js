// src/item.js
import { randomBytes } from 'node:crypto';

/** Sized so a seeded item is 965 B and a 20-item Query rounds to exactly 5 read blocks. */
export const PAYLOAD_BYTES = 940;
const PAYLOAD = 'x'.repeat(PAYLOAD_BYTES);

export function randomId() { return randomBytes(8).toString('hex'); }

export function buildItem({ pk, sk, expiresAt }) {
  const item = { pk, sk, payload: PAYLOAD };
  if (expiresAt !== undefined) item.expires_at = expiresAt;
  return item;
}

/** DynamoDB charges attribute names plus values, UTF-8; numbers are ~8 B. */
export function itemSizeBytes(item) {
  return Object.entries(item).reduce((n, [k, v]) =>
    n + Buffer.byteLength(k, 'utf8') +
    (typeof v === 'number' ? 8 : Buffer.byteLength(String(v), 'utf8')), 0);
}
