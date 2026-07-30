'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('shared visualizer modulation analysis follows the source spectrum range', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../visualizer/modulation-analysis.js'),
    'utf8',
  );
  assert.match(source, /this\.minFrequency = spectrum\.points\[0\]\.frequency/);
  assert.match(source, /this\.maxFrequency = spectrum\.points\[spectrum\.points\.length - 1\]\.frequency/);
  assert.match(source, /Math\.min\(12, this\.frameRate \/ 2\)/);
});

test('shared visualizer resets modulation history across source gaps', () => {
  const analysis = fs.readFileSync(
    path.join(__dirname, '../../visualizer/modulation-analysis.js'),
    'utf8',
  );
  const page = fs.readFileSync(path.join(__dirname, '../../visualizer/index.html'), 'utf8');
  assert.match(analysis, /timestampUs - this\.lastTimestampUs > intervalUs \* 3\) this\.reset\(\)/);
  assert.match(page, /if\(missingCount!==modulationMissingCount\)\{modulation\.reset\(\)/);
});
