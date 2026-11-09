'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const cfg = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'collector.yaml'), 'utf8'));

test('traces go otlp -> batch -> decouple -> otlphttp, decouple last', () => {
  const p = cfg.service.pipelines.traces;
  assert.deepEqual(p.receivers, ['otlp']);
  assert.deepEqual(p.processors, ['batch', 'decouple']);
  assert.deepEqual(p.exporters, ['otlphttp']);
});

test('the exporter takes endpoint and auth from the environment, never a literal', () => {
  const e = cfg.exporters.otlphttp;
  assert.equal(e.endpoint, '${env:GRAFANA_OTLP_ENDPOINT}');
  assert.equal(e.headers.Authorization, '${env:GRAFANA_OTLP_AUTH}');
});
