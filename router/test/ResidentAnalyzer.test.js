'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamBuffer } = require('../StreamBuffer');
const {
  ResidentAnalyzer,
  lowPassDecimate,
  selectCandidatePeaks,
} = require('../ResidentAnalyzer');

function makeBuffer({
  sampleRate = 40,
  durationSeconds = 60,
  signal,
  jitterUs = 0,
  skip = () => false,
}) {
  const buffer = new StreamBuffer({
    durationSeconds: durationSeconds + 2,
    maxInterpolationGapSeconds: 1,
  });
  const samples = [];
  const count = Math.floor(sampleRate * durationSeconds) + 1;
  for (let i = 0; i < count; i++) {
    if (skip(i)) continue;
    const timeSeconds = i / sampleRate;
    const jitter = jitterUs ? ((i % 5) - 2) * jitterUs : 0;
    samples.push([i, timeSeconds * 1e6 + jitter, signal(timeSeconds)]);
  }
  buffer.pushBatch(samples);
  return buffer;
}

function nearestCandidate(candidates, frequencyHz) {
  return [...candidates].sort((a, b) => (
    Math.abs(Math.log2(a.frequencyHz / frequencyHz))
    - Math.abs(Math.log2(b.frequencyHz / frequencyHz))
  ))[0];
}

test('boxcar low-pass decimation averages each source block', () => {
  const values = Float64Array.from([0, 2, 4, 6, 8, 10, 12, 14]);
  const valid = Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1]);
  const result = lowPassDecimate(values, valid, 4);

  assert.deepEqual([...result.values], [3, 11]);
  assert.equal(result.coverage, 1);
});

test('boxcar decimation marks blocks invalid when coverage is inadequate', () => {
  const values = Float64Array.from([0, 2, 4, 6, 8, 10, 12, 14]);
  const valid = Uint8Array.from([1, 1, 0, 0, 1, 1, 1, 1]);
  const result = lowPassDecimate(values, valid, 4, 0.75);

  assert.ok(Number.isNaN(result.values[0]));
  assert.equal(result.values[1], 11);
  assert.equal(result.coverage, 0.5);
});

test('waits when the requested analysis window has inadequate coverage', () => {
  const buffer = makeBuffer({
    durationSeconds: 20,
    signal: time => Math.sin(2 * Math.PI * time / 5),
    skip: index => index > 200 && index < 500,
  });
  const analyzer = new ResidentAnalyzer({
    windowSeconds: 20,
    analysisSampleRate: 4,
    minPeriodSeconds: 2,
    maxPeriodSeconds: 8,
    minCoverage: 0.95,
  });

  const result = analyzer.analyze(buffer);
  assert.equal(result.ready, false);
  assert.match(result.reason, /coverage/);
  assert.deepEqual(result.candidates, []);
});

test('detects a persistent oscillation from a timestamped StreamBuffer', () => {
  const targetFrequency = 0.2;
  const buffer = makeBuffer({
    durationSeconds: 60,
    jitterUs: 400,
    signal: time => (
      Math.sin(2 * Math.PI * targetFrequency * time)
      + 0.12 * Math.sin(2 * Math.PI * 3.2 * time)
    ),
  });
  const analyzer = new ResidentAnalyzer({
    windowSeconds: 60,
    analysisSampleRate: 4,
    oversampleFactor: 5,
    minPeriodSeconds: 2,
    maxPeriodSeconds: 12,
    numScales: 56,
    minExcessRatio: 1.2,
  });

  const result = analyzer.analyze(buffer);
  assert.equal(result.ready, true);
  assert.ok(result.candidates.length > 0);

  const candidate = nearestCandidate(result.candidates, targetFrequency);
  assert.ok(Math.abs(Math.log2(candidate.frequencyHz / targetFrequency)) < 0.18);
  assert.ok(candidate.completedCycles >= 2);
});

test('returns separated candidates for two resident oscillations', () => {
  const frequencies = [0.125, 0.4];
  const buffer = makeBuffer({
    durationSeconds: 80,
    signal: time => (
      1.2 * Math.sin(2 * Math.PI * frequencies[0] * time)
      + 0.8 * Math.sin(2 * Math.PI * frequencies[1] * time + 0.5)
    ),
  });
  const analyzer = new ResidentAnalyzer({
    windowSeconds: 80,
    analysisSampleRate: 5,
    minPeriodSeconds: 1.5,
    maxPeriodSeconds: 12,
    numScales: 64,
    minExcessRatio: 1.1,
    minPeakDistanceOctaves: 0.35,
  });

  const result = analyzer.analyze(buffer);
  assert.equal(result.ready, true);
  for (const frequency of frequencies) {
    const candidate = nearestCandidate(result.candidates, frequency);
    assert.ok(candidate);
    assert.ok(Math.abs(Math.log2(candidate.frequencyHz / frequency)) < 0.2);
  }
});

test('candidate selection enforces threshold, distance, and count', () => {
  const scales = [
    { frequencyHz: 1, periodSeconds: 1, recentPower: 5, backgroundPower: 1, excessRatio: 5, phase: 0, completedCycles: 10 },
    { frequencyHz: 0.9, periodSeconds: 1.11, recentPower: 4.5, backgroundPower: 1, excessRatio: 4.5, phase: 0, completedCycles: 10 },
    { frequencyHz: 0.7, periodSeconds: 1.43, recentPower: 1.5, backgroundPower: 1, excessRatio: 1.5, phase: 0, completedCycles: 10 },
    { frequencyHz: 0.5, periodSeconds: 2, recentPower: 4, backgroundPower: 1, excessRatio: 4, phase: 0, completedCycles: 10 },
    { frequencyHz: 0.25, periodSeconds: 4, recentPower: 3, backgroundPower: 1, excessRatio: 3, phase: 0, completedCycles: 10 },
  ];

  const candidates = selectCandidatePeaks(scales, {
    minExcessRatio: 2,
    minPeakDistanceOctaves: 0.3,
    maxCandidates: 2,
  });

  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map(candidate => candidate.frequencyHz), [1, 0.5]);
});
