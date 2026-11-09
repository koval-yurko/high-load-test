'use strict';

function count(env, key, dflt) {
  const raw = env[key];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return n;
}

// Every runtime setting is an environment variable set by Terraform, so a knob is a
// dev.tfvars edit, never a code change. AWS_MAX_ATTEMPTS is deliberately absent: the
// SDK reads it itself, and setting maxAttempts in code would override it.
function loadConfig(env = process.env) {
  if (!env.TABLE_NAME) throw new Error('TABLE_NAME is required');
  return { tableName: env.TABLE_NAME, heavyCpuIterations: count(env, 'HEAVY_CPU_ITERATIONS', 0) };
}

module.exports = { loadConfig };
