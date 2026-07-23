const test = require('node:test');
const assert = require('node:assert/strict');
const {
  welchPsd,
  spectrumPoints,
  logBandAverage,
  filterBackground,
  estimateSpectralSlope,
} = require('../../visualizer/spectral-analysis');

function random(seed = 0x12345678) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function gaussian(count, seed) {
  const uniform = random(seed);
  const result = new Float64Array(count);
  for (let i = 0; i < count; i += 2) {
    const radius = Math.sqrt(-2 * Math.log(Math.max(uniform(), 1e-12)));
    const angle = 2 * Math.PI * uniform();
    result[i] = radius * Math.cos(angle);
    if (i + 1 < count) result[i + 1] = radius * Math.sin(angle);
  }
  return result;
}

function pinkNoise(count, seed) {
  const white = gaussian(count, seed);
  const result = new Float64Array(count);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < count; i++) {
    const w = white[i];
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    result[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return result;
}

function brownNoise(count, seed) {
  const white = gaussian(count, seed);
  const result = new Float64Array(count);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += white[i];
    result[i] = sum;
  }
  return result;
}

function psd(values, rate = 1024, segmentLength = 1024, segments = 15) {
  return welchPsd(values, rate, segmentLength, segments, 0.5);
}

test('one-sided Welch PSD integrates to white-noise variance', () => {
  const values = gaussian(16384, 1);
  const spectrum = psd(values);
  const integratedPower = spectrum.power.reduce((sum, value) => sum + value, 0) * spectrum.resolution;
  assert.ok(integratedPower > 0.85 && integratedPower < 1.15, `integrated PSD ${integratedPower}`);
  assert.equal(spectrum.segmentCount, 15);
});

test('PSD locates a known sinusoid', () => {
  const rate = 1024;
  const frequency = 64;
  const values = Float64Array.from({ length: 16384 }, (_, i) =>
    Math.sin(2 * Math.PI * frequency * i / rate));
  const spectrum = psd(values, rate);
  let peak = 1;
  for (let i = 2; i < spectrum.power.length; i++) {
    if (spectrum.power[i] > spectrum.power[peak]) peak = i;
  }
  assert.equal(spectrum.frequency[peak], frequency);
});

test('spectral slope distinguishes white, pink, and brown noise', () => {
  const white = estimateSpectralSlope(psd(gaussian(32768, 2)), 4, 400);
  const pink = estimateSpectralSlope(psd(pinkNoise(32768, 3)), 4, 400);
  const brown = estimateSpectralSlope(psd(brownNoise(32768, 4)), 4, 400);
  assert.ok(Math.abs(white.alpha) < 0.2, `white alpha ${white.alpha}`);
  assert.ok(pink.alpha > 0.65 && pink.alpha < 1.35, `pink alpha ${pink.alpha}`);
  assert.ok(brown.alpha > 1.65 && brown.alpha < 2.35, `brown alpha ${brown.alpha}`);
  assert.equal(white.color, 'white-like');
  assert.equal(pink.color, 'pink-like');
  assert.equal(brown.color, 'red/brown-like');
});

test('log bands reduce points and retain a filtered spectral excess', () => {
  const rate = 1024;
  const values = pinkNoise(32768, 5);
  for (let i = 0; i < values.length; i++) values[i] += 2 * Math.sin(2 * Math.PI * 80 * i / rate);
  const spectrum = psd(values, rate);
  const raw = spectrumPoints(spectrum);
  const bands = logBandAverage(spectrum, 72);
  const filtered = filterBackground(bands);
  assert.ok(bands.length < raw.length);
  const peak = filtered.reduce((best, point) => point.power > best.power ? point : best);
  assert.ok(Math.abs(peak.frequency - 80) < 12, `filtered peak ${peak.frequency} Hz`);
  assert.ok(peak.power > 5, `filtered excess ${peak.power}`);
});
