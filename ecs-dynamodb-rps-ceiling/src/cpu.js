// src/cpu.js
import { pbkdf2Sync } from 'node:crypto';

const SALT = Buffer.from('ecs-dynamodb-rps-ceiling');

/** Deterministic, allocation-light CPU cost. Blocks the event loop by design. */
export function burn(iterations, seed) {
  if (!(iterations > 0)) return '';
  return pbkdf2Sync(seed, SALT, iterations, 8, 'sha256').toString('hex');
}
