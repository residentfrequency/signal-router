(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SpectralAnalysis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function fftReal(values) {
    const n = values.length;
    if (n < 2 || (n & (n - 1))) throw new Error('FFT length must be a power of two');
    const re = Float64Array.from(values);
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
    for (let len = 2; len <= n; len <<= 1) {
      const angle = -2 * Math.PI / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < len / 2; j++) {
          const c = Math.cos(angle * j);
          const s = Math.sin(angle * j);
          const u = re[i + j];
          const v = im[i + j];
          const x = re[i + j + len / 2] * c - im[i + j + len / 2] * s;
          const y = re[i + j + len / 2] * s + im[i + j + len / 2] * c;
          re[i + j] = u + x;
          im[i + j] = v + y;
          re[i + j + len / 2] = u - x;
          im[i + j + len / 2] = v - y;
        }
      }
    }
    return { re, im };
  }

  function welchPsd(samples, sampleRate, segmentLength, segmentLimit = 1, overlap = 0.5) {
    if (!(sampleRate > 0) || segmentLength < 8 || (segmentLength & (segmentLength - 1))) return null;
    if (samples.length < segmentLength) return null;
    const hop = Math.max(1, Math.round(segmentLength * (1 - overlap)));
    const available = 1 + Math.floor((samples.length - segmentLength) / hop);
    const count = Math.max(1, Math.min(segmentLimit, available));
    const first = samples.length - segmentLength - (count - 1) * hop;
    const bins = segmentLength / 2 + 1;
    const power = new Float64Array(bins);
    const window = new Float64Array(segmentLength);
    let windowEnergy = 0;
    let windowSum = 0;
    for (let i = 0; i < segmentLength; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (segmentLength - 1));
      window[i] = w;
      windowEnergy += w * w;
      windowSum += w;
    }
    for (let segment = 0; segment < count; segment++) {
      const offset = first + segment * hop;
      let mean = 0;
      for (let i = 0; i < segmentLength; i++) mean += samples[offset + i];
      mean /= segmentLength;
      const input = new Float64Array(segmentLength);
      for (let i = 0; i < segmentLength; i++) input[i] = (samples[offset + i] - mean) * window[i];
      const { re, im } = fftReal(input);
      for (let k = 0; k < bins; k++) {
        let value = (re[k] * re[k] + im[k] * im[k]) / (sampleRate * windowEnergy);
        if (k > 0 && k < segmentLength / 2) value *= 2;
        power[k] += value / count;
      }
    }
    const frequency = new Float64Array(bins);
    for (let k = 0; k < bins; k++) frequency[k] = k * sampleRate / segmentLength;
    return {
      frequency,
      power,
      sampleRate,
      segmentLength,
      segmentCount: count,
      overlap,
      resolution: sampleRate / segmentLength,
      fullScaleSinePsd: windowSum * windowSum / (2 * sampleRate * windowEnergy),
    };
  }

  function logBandAverage(spectrum, bandCount = 72) {
    const source = [];
    for (let i = 1; i < spectrum.frequency.length; i++) {
      const f = spectrum.frequency[i];
      const p = spectrum.power[i];
      if (f > 0 && p > 0 && Number.isFinite(p)) source.push({ frequency: f, power: p });
    }
    if (source.length < 2) return source;
    const lo = Math.log2(source[0].frequency);
    const hi = Math.log2(source[source.length - 1].frequency);
    const width = (hi - lo) / Math.max(1, bandCount);
    const result = [];
    let at = 0;
    for (let band = 0; band < bandCount; band++) {
      const lower = lo + band * width;
      const upper = lower + width;
      let sum = 0;
      let count = 0;
      while (at < source.length) {
        const value = Math.log2(source[at].frequency);
        if (value >= upper && band < bandCount - 1) break;
        if (value >= lower) {
          sum += source[at].power;
          count++;
        }
        at++;
      }
      if (count) result.push({
        frequency: Math.pow(2, lower + width / 2),
        power: sum / count,
        binCount: count,
      });
    }
    return result;
  }

  function spectrumPoints(spectrum) {
    const result = [];
    for (let i = 1; i < spectrum.frequency.length; i++) {
      const frequency = spectrum.frequency[i];
      const power = spectrum.power[i];
      if (frequency > 0 && power > 0 && Number.isFinite(power)) {
        result.push({ frequency, power, binCount: 1 });
      }
    }
    return result;
  }

  function rollingMedianBackground(points, halfWidthOctaves = 0.5) {
    return points.map(point => {
      const center = Math.log2(point.frequency);
      const neighbors = points
        .filter(candidate => Math.abs(Math.log2(candidate.frequency) - center) <= halfWidthOctaves)
        .map(candidate => candidate.power)
        .sort((a, b) => a - b);
      const middle = Math.floor(neighbors.length / 2);
      const median = neighbors.length % 2
        ? neighbors[middle]
        : (neighbors[middle - 1] + neighbors[middle]) / 2;
      return Math.max(median || point.power, Number.MIN_VALUE);
    });
  }

  function filterBackground(points, halfWidthOctaves = 0.5) {
    const background = rollingMedianBackground(points, halfWidthOctaves);
    return points.map((point, i) => ({
      ...point,
      rawPower: point.power,
      background: background[i],
      power: point.power / background[i],
    }));
  }

  function estimateSpectralSlope(spectrum, minFrequency, maxFrequency) {
    const nyquist = spectrum.sampleRate / 2;
    const lower = Math.max(minFrequency || spectrum.resolution * 2, spectrum.resolution);
    const upper = Math.min(maxFrequency || nyquist * 0.9, nyquist);
    const points = [];
    for (let i = 1; i < spectrum.frequency.length; i++) {
      const f = spectrum.frequency[i];
      const p = spectrum.power[i];
      if (f >= lower && f <= upper && p > 0 && Number.isFinite(p)) {
        points.push([Math.log10(f), Math.log10(p)]);
      }
    }
    if (points.length < 3) return { alpha: NaN, slope: NaN, r2: 0, count: points.length, color: 'unknown' };
    let mx = 0;
    let my = 0;
    for (const [x, y] of points) {
      mx += x;
      my += y;
    }
    mx /= points.length;
    my /= points.length;
    let covariance = 0;
    let varianceX = 0;
    let varianceY = 0;
    for (const [x, y] of points) {
      covariance += (x - mx) * (y - my);
      varianceX += (x - mx) ** 2;
      varianceY += (y - my) ** 2;
    }
    const slope = varianceX ? covariance / varianceX : NaN;
    const r2 = varianceX && varianceY ? covariance * covariance / (varianceX * varianceY) : 0;
    const alpha = -slope;
    let color = 'white-like';
    if (alpha < -1.5) color = 'violet-like';
    else if (alpha < -0.5) color = 'blue-like';
    else if (alpha < 0.5) color = 'white-like';
    else if (alpha < 1.5) color = 'pink-like';
    else if (alpha < 2.5) color = 'red/brown-like';
    else color = 'steep red-like';
    return { alpha, slope, r2, count: points.length, color, minFrequency: lower, maxFrequency: upper };
  }

  return {
    fftReal,
    welchPsd,
    spectrumPoints,
    logBandAverage,
    rollingMedianBackground,
    filterBackground,
    estimateSpectralSlope,
  };
});
