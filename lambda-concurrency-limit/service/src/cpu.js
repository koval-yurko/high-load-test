'use strict';
const { pbkdf2Sync } = require('node:crypto');

const SALT = Buffer.from('lambda-concurrency-limit');

// Deterministic CPU cost counted in iterations, not milliseconds: Lambda gives CPU in
// proportion to memory, so the same count takes less time with more memory.
function burn(iterations, seed) {
  if (!(iterations > 0)) return '0'.repeat(16);
  return pbkdf2Sync(seed, SALT, iterations, 8, 'sha256').toString('hex');
}

module.exports = { burn };
