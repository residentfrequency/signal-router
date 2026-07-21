'use strict';

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function fftMagnitudes(input) {
  const n = input.length;
  const re = Float64Array.from(input);
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = -2 * Math.PI / length;
    for (let offset = 0; offset < n; offset += length) {
      for (let j = 0; j < length / 2; j++) {
        const c = Math.cos(angle * j), s = Math.sin(angle * j);
        const evenRe = re[offset + j], evenIm = im[offset + j];
        const oddIndex = offset + j + length / 2;
        const oddRe = re[oddIndex] * c - im[oddIndex] * s;
        const oddIm = re[oddIndex] * s + im[oddIndex] * c;
        re[offset + j] = evenRe + oddRe;
        im[offset + j] = evenIm + oddIm;
        re[oddIndex] = evenRe - oddRe;
        im[oddIndex] = evenIm - oddIm;
      }
    }
  }
  const magnitudes = new Float64Array(n / 2);
  for (let i = 1; i < magnitudes.length; i++) magnitudes[i] = 2 * Math.hypot(re[i], im[i]) / n;
  return magnitudes;
}

function analyzeWindow(samples, sampleRate) {
  const n = samples.length;
  let mean = 0;
  for (const sample of samples) mean += sample;
  mean /= n;
  const windowed = new Float64Array(n);
  for (let i = 0; i < n; i++) windowed[i] = (samples[i] - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
  const magnitudes = fftMagnitudes(windowed);
  const nyquist = sampleRate / 2;
  const hzPerBin = sampleRate / n;

  function bandLevel(minHz, maxHz) {
    const first = Math.max(1, Math.ceil(minHz / hzPerBin));
    const last = Math.min(magnitudes.length - 1, Math.floor(Math.min(maxHz, nyquist) / hzPerBin));
    if (last < first) return 0;
    let total = 0;
    for (let i = first; i <= last; i++) {
      const db = 20 * Math.log10(Math.max(magnitudes[i], 1e-8));
      total += clamp01((db + 100) / 80);
    }
    return total / (last - first + 1);
  }

  let weighted = 0, amplitude = 0;
  for (let i = 1; i < magnitudes.length; i++) {
    const frequency = i * hzPerBin;
    weighted += frequency * magnitudes[i];
    amplitude += magnitudes[i];
  }
  const centroidHz = amplitude > 1e-8 ? weighted / amplitude : 0;
  const centroid = centroidHz > 0
    ? clamp01((Math.log10(Math.max(centroidHz, 20)) - Math.log10(20)) /
      (Math.log10(nyquist) - Math.log10(20)))
    : 0;

  return {
    bass: bandLevel(20, 200),
    mid: bandLevel(200, 2000),
    high: bandLevel(2000, nyquist),
    centroid,
    centroidHz
  };
}

class PcmAnalyzer {
  constructor({ fftSize = 2048, hopSize = 1024, smoothing = 0.2 } = {}) {
    this.fftSize = fftSize;
    this.hopSize = hopSize;
    this.smoothing = smoothing;
    this.samples = [];
    this.pending = 0;
    this.smoothed = null;
  }

  pushInt16LE(buffer, sampleRate) {
    for (let offset = 0; offset + 1 < buffer.length; offset += 2) this.samples.push(buffer.readInt16LE(offset) / 32768);
    this.pending += buffer.length / 2;
    if (this.samples.length > this.fftSize) this.samples.splice(0, this.samples.length - this.fftSize);
    if (this.samples.length < this.fftSize || this.pending < this.hopSize) return null;
    this.pending %= this.hopSize;
    const current = analyzeWindow(this.samples, sampleRate);
    if (!this.smoothed) this.smoothed = current;
    else {
      for (const key of ['bass', 'mid', 'high', 'centroid', 'centroidHz']) {
        this.smoothed[key] += (current[key] - this.smoothed[key]) * this.smoothing;
      }
    }
    return { ...this.smoothed };
  }
}

module.exports = { PcmAnalyzer, analyzeWindow, fftMagnitudes };
