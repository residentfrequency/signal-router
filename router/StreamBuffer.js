'use strict';

/**
 * Fixed-duration buffer for timestamped scalar samples.
 *
 * The router receives samples as [sequence, timestampUs, value]. StreamBuffer
 * keeps those samples ordered, trims old history, and can produce a uniformly
 * sampled series for FFT/CWT analysis without assuming packet arrival timing is
 * perfectly regular.
 */
class StreamBuffer {
  constructor({
    durationSeconds = 60,
    maxInterpolationGapSeconds = 1,
  } = {}) {
    if (!(durationSeconds > 0)) {
      throw new RangeError('durationSeconds must be greater than zero');
    }
    if (!(maxInterpolationGapSeconds >= 0)) {
      throw new RangeError('maxInterpolationGapSeconds must be zero or greater');
    }

    this.durationUs = durationSeconds * 1e6;
    this.maxInterpolationGapUs = maxInterpolationGapSeconds * 1e6;
    this.samples = [];
  }

  get size() {
    return this.samples.length;
  }

  get durationSeconds() {
    if (this.samples.length < 2) return 0;
    return (this.samples[this.samples.length - 1].timestampUs - this.samples[0].timestampUs) / 1e6;
  }

  get firstTimestampUs() {
    return this.samples[0]?.timestampUs ?? null;
  }

  get lastTimestampUs() {
    return this.samples[this.samples.length - 1]?.timestampUs ?? null;
  }

  clear() {
    this.samples.length = 0;
  }

  /**
   * Add one sample. Duplicate timestamps replace the previous value. Samples
   * that arrive out of order are inserted into the correct position.
   */
  push(timestampUs, value, sequence = null) {
    const sample = StreamBuffer.normalizeSample({ timestampUs, value, sequence });
    const index = this.#lowerBound(sample.timestampUs);

    if (index < this.samples.length && this.samples[index].timestampUs === sample.timestampUs) {
      this.samples[index] = sample;
    } else {
      this.samples.splice(index, 0, sample);
    }

    this.#trim();
    return this.size;
  }

  /**
   * Add router samples shaped as [sequence, timestampUs, value], or objects
   * containing timestampUs/value. Invalid samples throw rather than silently
   * contaminating later spectral analysis.
   */
  pushBatch(samples) {
    if (!Array.isArray(samples)) throw new TypeError('samples must be an array');
    if (samples.length === 0) return this.size;

    const normalized = samples.map(StreamBuffer.normalizeSample)
      .sort((a, b) => a.timestampUs - b.timestampUs);

    const incoming = [];
    for (const sample of normalized) {
      const previous = incoming[incoming.length - 1];
      if (previous?.timestampUs === sample.timestampUs) incoming[incoming.length - 1] = sample;
      else incoming.push(sample);
    }

    const lastExisting = this.samples[this.samples.length - 1];
    if (!lastExisting || incoming[0].timestampUs >= lastExisting.timestampUs) {
      if (lastExisting?.timestampUs === incoming[0].timestampUs) this.samples.pop();
      this.samples.push(...incoming);
      this.#trim();
      return this.size;
    }

    this.samples.push(...incoming);
    this.samples.sort((a, b) => a.timestampUs - b.timestampUs);

    // Keep the newest value when duplicate timestamps occur.
    const deduplicated = [];
    for (const sample of this.samples) {
      const previous = deduplicated[deduplicated.length - 1];
      if (previous?.timestampUs === sample.timestampUs) deduplicated[deduplicated.length - 1] = sample;
      else deduplicated.push(sample);
    }
    this.samples = deduplicated;
    this.#trim();
    return this.size;
  }

  /**
   * Return a regular time grid suitable for FFT/CWT analysis.
   *
   * Linear interpolation is the default. Hold interpolation uses the most
   * recent preceding raw value. Both modes reject intervals where surrounding
   * raw samples are farther apart than maxInterpolationGapSeconds, representing
   * those transport gaps as NaN with valid[i] = 0 rather than inventing data.
   */
  resample({
    sampleRate,
    durationSeconds = this.durationUs / 1e6,
    endTimestampUs = this.lastTimestampUs,
    maxInterpolationGapSeconds = this.maxInterpolationGapUs / 1e6,
    interpolation = 'linear',
  } = {}) {
    if (!(sampleRate > 0)) throw new RangeError('sampleRate must be greater than zero');
    if (!(durationSeconds > 0)) throw new RangeError('durationSeconds must be greater than zero');
    if (!(maxInterpolationGapSeconds >= 0)) {
      throw new RangeError('maxInterpolationGapSeconds must be zero or greater');
    }
    if (interpolation !== 'linear' && interpolation !== 'hold') {
      throw new RangeError("interpolation must be 'linear' or 'hold'");
    }
    if (!Number.isFinite(endTimestampUs) || this.samples.length === 0) {
      return StreamBuffer.emptySeries(sampleRate);
    }

    const intervalUs = 1e6 / sampleRate;
    const count = Math.max(1, Math.floor(durationSeconds * sampleRate) + 1);
    const startTimestampUs = endTimestampUs - (count - 1) * intervalUs;
    const values = new Float64Array(count);
    const timestampsUs = new Float64Array(count);
    const valid = new Uint8Array(count);
    values.fill(Number.NaN);

    let right = this.#lowerBound(startTimestampUs);
    if (right > 0) right--;
    const maxGapUs = maxInterpolationGapSeconds * 1e6;

    for (let i = 0; i < count; i++) {
      const timestampUs = startTimestampUs + i * intervalUs;
      timestampsUs[i] = timestampUs;

      while (right + 1 < this.samples.length && this.samples[right + 1].timestampUs < timestampUs) {
        right++;
      }

      const leftSample = this.samples[right];
      const rightSample = this.samples[right + 1];

      if (leftSample?.timestampUs === timestampUs) {
        values[i] = leftSample.value;
        valid[i] = 1;
        continue;
      }
      if (rightSample?.timestampUs === timestampUs) {
        values[i] = rightSample.value;
        valid[i] = 1;
        continue;
      }
      if (!leftSample || !rightSample) continue;

      const gapUs = rightSample.timestampUs - leftSample.timestampUs;
      if (!(gapUs > 0) || gapUs > maxGapUs) continue;
      if (timestampUs < leftSample.timestampUs || timestampUs > rightSample.timestampUs) continue;

      values[i] = interpolation === 'hold'
        ? leftSample.value
        : leftSample.value
          + ((timestampUs - leftSample.timestampUs) / gapUs)
          * (rightSample.value - leftSample.value);
      valid[i] = 1;
    }

    let validCount = 0;
    for (const flag of valid) validCount += flag;

    return {
      values,
      timestampsUs,
      valid,
      validCount,
      coverage: validCount / count,
      sampleRate,
      intervalUs,
      startTimestampUs,
      endTimestampUs,
    };
  }

  /**
   * Convenience snapshot for diagnostics and tests.
   */
  toArray() {
    return this.samples.map(sample => ({ ...sample }));
  }

  static normalizeSample(sample) {
    let sequence = null;
    let timestampUs;
    let value;

    if (Array.isArray(sample)) {
      if (sample.length < 3) {
        throw new TypeError('array samples must be [sequence, timestampUs, value]');
      }
      [sequence, timestampUs, value] = sample;
    } else if (sample && typeof sample === 'object') {
      ({ sequence = null, timestampUs, value } = sample);
    } else {
      throw new TypeError('sample must be an array or object');
    }

    timestampUs = Number(timestampUs);
    value = Number(value);
    if (!Number.isFinite(timestampUs) || !Number.isFinite(value)) {
      throw new TypeError('timestampUs and value must be finite numbers');
    }

    return {
      sequence: Number.isFinite(Number(sequence)) ? Number(sequence) : null,
      timestampUs,
      value,
    };
  }

  static emptySeries(sampleRate) {
    return {
      values: new Float64Array(0),
      timestampsUs: new Float64Array(0),
      valid: new Uint8Array(0),
      validCount: 0,
      coverage: 0,
      sampleRate,
      intervalUs: 1e6 / sampleRate,
      startTimestampUs: null,
      endTimestampUs: null,
    };
  }

  #trim() {
    if (this.samples.length === 0) return;
    const cutoffUs = this.samples[this.samples.length - 1].timestampUs - this.durationUs;
    const firstRetained = this.#lowerBound(cutoffUs);
    if (firstRetained > 0) this.samples.splice(0, firstRetained);
  }

  #lowerBound(timestampUs) {
    let low = 0;
    let high = this.samples.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.samples[middle].timestampUs < timestampUs) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

module.exports = { StreamBuffer };
