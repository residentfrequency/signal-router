'use strict';

const { computeCwt, summarizeCwt } = require('./cwt');

class ResidentAnalyzer {
  constructor({
    windowSeconds = 60,
    analysisSampleRate = 5,
    oversampleFactor = 4,
    minCoverage = 0.95,
    minPeriodSeconds = 1,
    maxPeriodSeconds = 20,
    numScales = 48,
    recentFraction = 0.25,
    minCompletedCycles = 2,
    minExcessRatio = 2,
    maxCandidates = 8,
    minPeakDistanceOctaves = 0.2,
    decimationValidFraction = 0.8,
  } = {}) {
    if (!(windowSeconds > 0)) throw new RangeError('windowSeconds must be greater than zero');
    if (!(analysisSampleRate > 0)) throw new RangeError('analysisSampleRate must be greater than zero');
    if (!Number.isInteger(oversampleFactor) || oversampleFactor < 1) {
      throw new RangeError('oversampleFactor must be a positive integer');
    }
    if (!(minCoverage >= 0 && minCoverage <= 1)) throw new RangeError('minCoverage must be between zero and one');
    if (!(minPeriodSeconds > 0) || !(maxPeriodSeconds > minPeriodSeconds)) {
      throw new RangeError('period range must satisfy 0 < min < max');
    }
    if (!Number.isInteger(numScales) || numScales < 3) throw new RangeError('numScales must be at least 3');
    if (!(recentFraction > 0 && recentFraction <= 1)) throw new RangeError('recentFraction must be in (0, 1]');
    if (!(minCompletedCycles >= 0)) throw new RangeError('minCompletedCycles must be zero or greater');
    if (!(minExcessRatio >= 0)) throw new RangeError('minExcessRatio must be zero or greater');
    if (!Number.isInteger(maxCandidates) || maxCandidates < 1) throw new RangeError('maxCandidates must be positive');
    if (!(minPeakDistanceOctaves >= 0)) throw new RangeError('minPeakDistanceOctaves must be zero or greater');
    if (!(decimationValidFraction > 0 && decimationValidFraction <= 1)) {
      throw new RangeError('decimationValidFraction must be in (0, 1]');
    }

    Object.assign(this, {
      windowSeconds,
      analysisSampleRate,
      oversampleFactor,
      minCoverage,
      minPeriodSeconds,
      maxPeriodSeconds,
      numScales,
      recentFraction,
      minCompletedCycles,
      minExcessRatio,
      maxCandidates,
      minPeakDistanceOctaves,
      decimationValidFraction,
    });
  }

  analyze(streamBuffer, { endTimestampUs = streamBuffer?.lastTimestampUs } = {}) {
    if (!streamBuffer || typeof streamBuffer.resample !== 'function') {
      throw new TypeError('streamBuffer must provide resample()');
    }

    const inputSampleRate = this.analysisSampleRate * this.oversampleFactor;
    const input = streamBuffer.resample({
      sampleRate: inputSampleRate,
      durationSeconds: this.windowSeconds,
      endTimestampUs,
    });

    if (input.values.length === 0) return this.#waiting('empty', input.coverage);
    if (input.coverage < this.minCoverage) return this.#waiting('coverage', input.coverage);

    const decimated = lowPassDecimate(
      input.values,
      input.valid,
      this.oversampleFactor,
      this.decimationValidFraction,
    );

    if (decimated.coverage < this.minCoverage) return this.#waiting('decimated-coverage', decimated.coverage);
    if (decimated.values.length < 8) return this.#waiting('window', decimated.coverage);

    const cwt = computeCwt(decimated.values, {
      sampleRate: this.analysisSampleRate,
      minPeriodSeconds: this.minPeriodSeconds,
      maxPeriodSeconds: this.maxPeriodSeconds,
      numScales: this.numScales,
    });
    const scales = summarizeCwt(cwt, { recentFraction: this.recentFraction });
    const candidates = selectCandidatePeaks(scales, {
      minCompletedCycles: this.minCompletedCycles,
      minExcessRatio: this.minExcessRatio,
      maxCandidates: this.maxCandidates,
      minPeakDistanceOctaves: this.minPeakDistanceOctaves,
    });

    return {
      ready: true,
      reason: null,
      coverage: decimated.coverage,
      inputCoverage: input.coverage,
      sampleRate: this.analysisSampleRate,
      sampleCount: decimated.values.length,
      durationSeconds: cwt.durationSeconds,
      alpha: cwt.alpha,
      mean: cwt.mean,
      variance: cwt.variance,
      scales,
      candidates,
      endTimestampUs,
    };
  }

  #waiting(reason, coverage) {
    return {
      ready: false,
      reason,
      coverage: Number.isFinite(coverage) ? coverage : 0,
      candidates: [],
      scales: [],
    };
  }
}

function lowPassDecimate(values, valid, factor, minValidFraction = 0.8) {
  if (!values || !valid || values.length !== valid.length) {
    throw new TypeError('values and valid must have equal lengths');
  }
  if (!Number.isInteger(factor) || factor < 1) throw new RangeError('factor must be a positive integer');

  const count = Math.floor(values.length / factor);
  const output = new Float64Array(count);
  let validCount = 0;

  for (let i = 0; i < count; i++) {
    let sum = 0;
    let countValid = 0;
    const start = i * factor;
    for (let j = 0; j < factor; j++) {
      const index = start + j;
      if (valid[index] && Number.isFinite(values[index])) {
        sum += values[index];
        countValid++;
      }
    }

    if (countValid / factor >= minValidFraction) {
      output[i] = sum / countValid;
      validCount++;
    } else {
      output[i] = Number.NaN;
    }
  }

  return {
    values: output,
    validCount,
    coverage: count ? validCount / count : 0,
  };
}

function selectCandidatePeaks(scales, {
  minCompletedCycles = 2,
  minExcessRatio = 2,
  maxCandidates = 8,
  minPeakDistanceOctaves = 0.2,
} = {}) {
  const localPeaks = [];

  for (let i = 0; i < scales.length; i++) {
    const scale = scales[i];
    if (scale.completedCycles < minCompletedCycles || scale.excessRatio < minExcessRatio) continue;

    const previous = scales[i - 1]?.excessRatio ?? -Infinity;
    const next = scales[i + 1]?.excessRatio ?? -Infinity;
    if (scale.excessRatio < previous || scale.excessRatio < next) continue;

    localPeaks.push({
      scaleIndex: i,
      frequencyHz: scale.frequencyHz,
      periodSeconds: scale.periodSeconds,
      strength: scale.recentPower,
      backgroundPower: scale.backgroundPower,
      excessRatio: scale.excessRatio,
      phase: scale.phase,
      completedCycles: scale.completedCycles,
    });
  }

  localPeaks.sort((a, b) => b.excessRatio - a.excessRatio);
  const selected = [];
  for (const candidate of localPeaks) {
    const tooClose = selected.some(existing => (
      Math.abs(Math.log2(candidate.frequencyHz / existing.frequencyHz)) < minPeakDistanceOctaves
    ));
    if (!tooClose) selected.push(candidate);
    if (selected.length >= maxCandidates) break;
  }

  return selected;
}

module.exports = {
  ResidentAnalyzer,
  lowPassDecimate,
  selectCandidatePeaks,
};
