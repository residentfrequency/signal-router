'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../recorder.js'), 'utf8');

test('records timestamped OSC samples but ignores binary PCM', () => {
  assert.match(source, /if \(isBinary\) return/);
  assert.match(source, /device\.startsWith\('osc\/'\)/);
  assert.match(source, /timestamp_us: timestampUs/);
  assert.match(source, /sequence: Number\.isFinite/);
});

test('uses hourly Parquet files and stops at storage safeguards', () => {
  assert.match(source, /ParquetWriter\.openFile/);
  assert.match(source, /hourKey/);
  assert.match(source, /20 \* 1024 \*\* 3/);
  assert.match(source, /MIN_FREE_BYTES/);
  assert.match(source, /storage ceiling reached/);
});

test('does not misclassify intentionally sparse sequence channels as loss', () => {
  assert.match(source, /nominalSequenceStep/);
  assert.match(source, /nominalSequenceStep === 1 && delta > 1/);
});

test('exposes local-only recording controls', () => {
  assert.match(source, /POST' && request\.url === '\/api\/start'/);
  assert.match(source, /POST' && request\.url === '\/api\/stop'/);
  assert.match(source, /server\.listen\(PORT, '127\.0\.0\.1'/);
  assert.match(source, /const stopButton=document\.getElementById\('stop'\)/);
  assert.match(source, /stopButton\.addEventListener\('click'/);
  assert.doesNotMatch(source, /stop\.onclick/);
});
