(function (global) {
  'use strict';

  class ModulationAnalysis {
    constructor({ frequencyBins = 72, modulationBins = 48, historySize = 128 } = {}) {
      this.frequencyBins = frequencyBins;
      this.modulationBins = modulationBins;
      this.historySize = historySize;
      this.history = Array.from({ length: frequencyBins }, () => new Float32Array(historySize));
      this.positions = new Uint16Array(frequencyBins);
      this.filled = new Uint16Array(frequencyBins);
      this.display = Array.from(
        { length: frequencyBins },
        () => new Float32Array(modulationBins + 1),
      );
      this.lastTimestampUs = 0;
      this.minFrequency = 0;
      this.maxFrequency = 0;
      this.frameRate = 0;
      this.mode = 'raw';
    }

    reset() {
      for (const row of this.history) row.fill(0);
      for (const row of this.display) row.fill(0);
      this.positions.fill(0);
      this.filled.fill(0);
      this.lastTimestampUs = 0;
    }

    ingest(spectrum, timestampUs, frameRate, mode) {
      if (!spectrum?.points?.length || !(timestampUs > 0) || !(frameRate > 0)) return false;
      const intervalUs = 1e6 / frameRate;
      if (this.lastTimestampUs && timestampUs - this.lastTimestampUs < intervalUs) return false;

      this.lastTimestampUs = timestampUs;
      this.frameRate = frameRate;
      this.mode = mode;
      this.minFrequency = spectrum.points[0].frequency;
      this.maxFrequency = spectrum.points[spectrum.points.length - 1].frequency;

      for (let bin = 0; bin < this.frequencyBins; bin++) {
        const q = (bin + 0.5) / this.frequencyBins;
        const frequency = this.minFrequency
          * (this.maxFrequency / this.minFrequency) ** q;
        const power = valueAtFrequency(frequency, spectrum.points);
        const level = mode === 'filtered'
          ? 10 * Math.log10(Math.max(power, Number.MIN_VALUE))
          : 10 * Math.log10(Math.max(power, Number.MIN_VALUE) / spectrum.referencePsd);
        const position = this.positions[bin];
        this.history[bin][position] = level;
        this.positions[bin] = (position + 1) % this.historySize;
        this.filled[bin] = Math.min(this.historySize, this.filled[bin] + 1);
        this.display[bin][0] = mode === 'filtered'
          ? clamp((level + 3) / 12)
          : clamp((level + 100) / 100);
      }
      this.#computeModulation();
      return true;
    }

    #computeModulation() {
      const maximum = Math.min(12, this.frameRate / 2);
      const minimum = Math.max(0.05, this.frameRate / this.historySize);
      for (let bin = 0; bin < this.frequencyBins; bin++) {
        const count = this.filled[bin];
        if (count < 16) continue;
        const history = this.history[bin];
        const start = (this.positions[bin] - count + this.historySize) % this.historySize;
        let mean = 0;
        for (let index = 0; index < count; index++) {
          mean += history[(start + index) % this.historySize];
        }
        mean /= count;

        for (let column = 1; column <= this.modulationBins; column++) {
          const q = (column - 1) / Math.max(1, this.modulationBins - 1);
          const frequency = minimum * (maximum / minimum) ** q;
          let real = 0;
          let imaginary = 0;
          let weightSum = 0;
          for (let index = 0; index < count; index++) {
            const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / Math.max(1, count - 1));
            const value = history[(start + index) % this.historySize] - mean;
            const phase = 2 * Math.PI * frequency * index / this.frameRate;
            real += value * weight * Math.cos(phase);
            imaginary -= value * weight * Math.sin(phase);
            weightSum += weight;
          }
          const swingDb = 2 * Math.hypot(real, imaginary) / Math.max(1, weightSum);
          this.display[bin][column] = clamp(Math.log1p(swingDb) / Math.log(7));
        }
      }
    }

    metadata() {
      const maximum = Math.min(12, this.frameRate / 2);
      const minimum = Math.max(0.05, this.frameRate / this.historySize);
      return {
        minFrequency: this.minFrequency,
        maxFrequency: this.maxFrequency,
        minModulation: minimum,
        maxModulation: maximum,
        modulationResolution: this.frameRate / this.historySize,
        historySeconds: this.frameRate ? this.historySize / this.frameRate : 0,
      };
    }
  }

  function valueAtFrequency(frequency, points) {
    let high = 1;
    while (high < points.length && points[high].frequency < frequency) high++;
    if (high >= points.length) return points[points.length - 1].power;
    const low = Math.max(0, high - 1);
    const span = points[high].frequency - points[low].frequency;
    const mix = span ? (frequency - points[low].frequency) / span : 0;
    return points[low].power * (1 - mix) + points[high].power * mix;
  }

  function clamp(value) {
    return Math.max(0, Math.min(1, value));
  }

  global.ModulationAnalysis = ModulationAnalysis;
})(window);
