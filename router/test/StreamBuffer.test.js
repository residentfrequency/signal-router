'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamBuffer } = require('../StreamBuffer');

test('stores router batches in timestamp order and replaces duplicate timestamps', () => {
  const buffer = new StreamBuffer({ durationSeconds: 10 });
  buffer.pushBatch([
    [3, 3_000_000, 30],
    [1, 1_000_000, 10],
    [2, 2_000_000, 20],
    [4, 2_000_000, 22],
  ]);

  assert.deepEqual(buffer.toArray(), [
    { sequence: 1, timestampUs: 1_000_000, value: 10 },
    { sequence: 4, timestampUs: 2_000_000, value: 22 },
    { sequence: 3, timestampUs: 3_000_000, value: 30 },
  ]);
});

test('trims history relative to the newest timestamp', () => {
  const buffer = new StreamBuffer({ durationSeconds: 2 });
  buffer.pushBatch([
    [0, 0, 0],
    [1, 1_000_000, 1],
    [2, 2_000_000, 2],
    [3, 3_000_000, 3],
  ]);

  assert.equal(buffer.size, 3);
  assert.equal(buffer.firstTimestampUs, 1_000_000);
  assert.equal(buffer.lastTimestampUs, 3_000_000);
});

test('linearly resamples irregular timestamps onto a uniform grid by default', () => {
  const buffer = new StreamBuffer({
    durationSeconds: 4,
    maxInterpolationGapSeconds: 2,
  });
  buffer.pushBatch([
    [0, 0, 0],
    [1, 900_000, 0.9],
    [2, 2_100_000, 2.1],
    [3, 3_000_000, 3],
  ]);

  const series = buffer.resample({
    sampleRate: 1,
    durationSeconds: 3,
    endTimestampUs: 3_000_000,
  });

  assert.deepEqual([...series.timestampsUs], [0, 1_000_000, 2_000_000, 3_000_000]);
  assert.deepEqual([...series.valid], [1, 1, 1, 1]);
  assert.equal(series.coverage, 1);
  assert.ok(Math.abs(series.values[1] - 1) < 1e-12);
  assert.ok(Math.abs(series.values[2] - 2) < 1e-12);
});

test('hold interpolation uses the most recent preceding value', () => {
  const buffer = new StreamBuffer({
    durationSeconds: 4,
    maxInterpolationGapSeconds: 2,
  });
  buffer.pushBatch([
    [0, 0, 10],
    [1, 1_500_000, 20],
    [2, 3_000_000, 30],
  ]);

  const series = buffer.resample({
    sampleRate: 2,
    durationSeconds: 3,
    endTimestampUs: 3_000_000,
    interpolation: 'hold',
  });

  assert.deepEqual([...series.timestampsUs], [
    0,
    500_000,
    1_000_000,
    1_500_000,
    2_000_000,
    2_500_000,
    3_000_000,
  ]);
  assert.deepEqual([...series.values], [10, 10, 10, 20, 20, 20, 30]);
  assert.deepEqual([...series.valid], [1, 1, 1, 1, 1, 1, 1]);
});

test('hold interpolation marks long gaps invalid', () => {
  const buffer = new StreamBuffer({
    durationSeconds: 10,
    maxInterpolationGapSeconds: 1.5,
  });
  buffer.pushBatch([
    [0, 0, 10],
    [1, 1_000_000, 20],
    [2, 5_000_000, 30],
  ]);

  const series = buffer.resample({
    sampleRate: 1,
    durationSeconds: 5,
    endTimestampUs: 5_000_000,
    interpolation: 'hold',
  });

  assert.deepEqual([...series.valid], [1, 1, 0, 0, 0, 1]);
  assert.deepEqual([...series.values].map(value => Number.isNaN(value) ? null : value), [
    10,
    20,
    null,
    null,
    null,
    30,
  ]);
});

test('rejects unsupported interpolation modes', () => {
  const buffer = new StreamBuffer();
  buffer.push(0, 1);

  assert.throws(
    () => buffer.resample({ sampleRate: 1, interpolation: 'spline' }),
    /interpolation must be 'linear' or 'hold'/,
  );
});

test('marks long gaps invalid instead of inventing a ramp', () => {
  const buffer = new StreamBuffer({
    durationSeconds: 10,
    maxInterpolationGapSeconds: 1.5,
  });
  buffer.pushBatch([
    [0, 0, 0],
    [1, 1_000_000, 1],
    [2, 5_000_000, 5],
  ]);

  const series = buffer.resample({
    sampleRate: 1,
    durationSeconds: 5,
    endTimestampUs: 5_000_000,
  });

  assert.deepEqual([...series.valid], [1, 1, 0, 0, 0, 1]);
  assert.ok(Number.isNaN(series.values[2]));
  assert.equal(series.validCount, 3);
  assert.equal(series.coverage, 0.5);
});

test('returns an empty typed series when no samples are available', () => {
  const buffer = new StreamBuffer();
  const series = buffer.resample({ sampleRate: 10 });

  assert.equal(series.values.length, 0);
  assert.equal(series.valid.length, 0);
  assert.equal(series.coverage, 0);
});
