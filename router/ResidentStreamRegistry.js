'use strict';

const { StreamBuffer } = require('./StreamBuffer');
const { ResidentAnalyzer } = require('./ResidentAnalyzer');
const { VoiceTracker } = require('./VoiceTracker');

class ResidentStreamRegistry {
  constructor({
    bufferOptions = { durationSeconds: 120, maxInterpolationGapSeconds: 1 },
    analyzerOptions = {},
    trackerOptions = {},
    interpolationFor = () => 'linear',
    staleAfterSeconds = 300,
    createBuffer = options => new StreamBuffer(options),
    createAnalyzer = options => new ResidentAnalyzer(options),
    createTracker = options => new VoiceTracker(options),
  } = {}) {
    if (typeof interpolationFor !== 'function') throw new TypeError('interpolationFor must be a function');
    if (!(staleAfterSeconds > 0)) throw new RangeError('staleAfterSeconds must be greater than zero');

    Object.assign(this, {
      bufferOptions,
      analyzerOptions,
      trackerOptions,
      interpolationFor,
      staleAfterUs: staleAfterSeconds * 1e6,
      createBuffer,
      createAnalyzer,
      createTracker,
    });
    this.streams = new Map();
  }

  get size() {
    return this.streams.size;
  }

  ingest(streamId, timestampUs, value, sequence = null) {
    if (typeof streamId !== 'string' || !streamId) throw new TypeError('streamId must be a non-empty string');
    timestampUs = Number(timestampUs);
    value = Number(value);
    if (!Number.isFinite(timestampUs) || !Number.isFinite(value)) return false;

    const entry = this.#entry(streamId);
    entry.buffer.push(timestampUs, value, sequence);
    entry.lastTimestampUs = Math.max(entry.lastTimestampUs ?? -Infinity, timestampUs);
    return true;
  }

  ingestBatch(streamId, samples) {
    if (typeof streamId !== 'string' || !streamId) throw new TypeError('streamId must be a non-empty string');
    if (!Array.isArray(samples)) throw new TypeError('samples must be an array');
    const finite = samples.filter(sample => Array.isArray(sample)
      && Number.isFinite(Number(sample[1]))
      && Number.isFinite(Number(sample[2])));
    if (finite.length === 0) return 0;

    const entry = this.#entry(streamId);
    entry.buffer.pushBatch(finite);
    entry.lastTimestampUs = entry.buffer.lastTimestampUs;
    return finite.length;
  }

  analyzeAll({ nowTimestampUs = Date.now() * 1000 } = {}) {
    const messages = [];
    for (const [streamId, entry] of this.streams) {
      if (nowTimestampUs - entry.lastTimestampUs > this.staleAfterUs) {
        this.streams.delete(streamId);
        continue;
      }

      const interpolation = this.interpolationFor(streamId);
      const analysis = entry.analyzer.analyze(entry.buffer, {
        endTimestampUs: entry.lastTimestampUs,
        interpolation,
      });
      const voices = entry.tracker.update(
        analysis.ready ? analysis.candidates : [],
        { timestampUs: entry.lastTimestampUs },
      );
      messages.push({
        type: 'resident_voices',
        device: streamId,
        timestampUs: entry.lastTimestampUs,
        interpolation,
        ready: analysis.ready,
        reason: analysis.reason,
        coverage: analysis.coverage,
        voices,
      });
    }
    return messages;
  }

  snapshot(streamId) {
    const entry = this.streams.get(streamId);
    if (!entry) return null;
    return {
      device: streamId,
      lastTimestampUs: entry.lastTimestampUs,
      sampleCount: entry.buffer.size,
      voices: entry.tracker.snapshot(),
    };
  }

  #entry(streamId) {
    let entry = this.streams.get(streamId);
    if (!entry) {
      entry = {
        buffer: this.createBuffer(this.bufferOptions),
        analyzer: this.createAnalyzer(this.analyzerOptions),
        tracker: this.createTracker(this.trackerOptions),
        lastTimestampUs: null,
      };
      this.streams.set(streamId, entry);
    }
    return entry;
  }
}

module.exports = { ResidentStreamRegistry };
