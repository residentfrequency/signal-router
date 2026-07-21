'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PcmAnalyzer, analyzeWindow } = require('../audio-analysis');

function sine(frequency, sampleRate = 16000, count = 2048) {
  return Float64Array.from({ length: count }, (_, i) => 0.8 * Math.sin(2 * Math.PI * frequency * i / sampleRate));
}

test('classifies low, middle, and high tones into their bands', () => {
  const bass = analyzeWindow(sine(100), 16000);
  const mid = analyzeWindow(sine(1000), 16000);
  const high = analyzeWindow(sine(4000), 16000);
  assert.ok(bass.bass > bass.mid && bass.bass > bass.high);
  assert.ok(mid.mid > mid.bass && mid.mid > mid.high);
  assert.ok(high.high > high.bass && high.high > high.mid);
});

test('reports a higher centroid for a higher tone', () => {
  const low = analyzeWindow(sine(200), 16000);
  const high = analyzeWindow(sine(4000), 16000);
  assert.ok(high.centroid > low.centroid);
  assert.ok(Math.abs(high.centroidHz - 4000) < 50);
});

test('streaming analyzer waits for a complete FFT window', () => {
  const analyzer = new PcmAnalyzer();
  const packet = Buffer.alloc(320 * 2);
  assert.equal(analyzer.pushInt16LE(packet, 16000), null);
});
