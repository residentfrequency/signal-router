'use strict';

class VoiceTracker {
  constructor({
    maxVoices = 8,
    matchDistanceOctaves = 0.25,
    frequencySmoothing = 0.25,
    strengthSmoothing = 0.25,
    confidenceAttack = 0.2,
    confidenceRelease = 0.08,
    activationConfidence = 0.45,
    releaseConfidence = 0.1,
    maxMisses = 6,
  } = {}) {
    if (!Number.isInteger(maxVoices) || maxVoices < 1) throw new RangeError('maxVoices must be positive');
    if (!(matchDistanceOctaves >= 0)) throw new RangeError('matchDistanceOctaves must be zero or greater');
    for (const [name, value] of Object.entries({
      frequencySmoothing,
      strengthSmoothing,
      confidenceAttack,
      confidenceRelease,
      activationConfidence,
      releaseConfidence,
    })) {
      if (!(value >= 0 && value <= 1)) throw new RangeError(`${name} must be between zero and one`);
    }
    if (releaseConfidence > activationConfidence) {
      throw new RangeError('releaseConfidence must not exceed activationConfidence');
    }
    if (!Number.isInteger(maxMisses) || maxMisses < 0) throw new RangeError('maxMisses must be zero or greater');

    Object.assign(this, {
      maxVoices,
      matchDistanceOctaves,
      frequencySmoothing,
      strengthSmoothing,
      confidenceAttack,
      confidenceRelease,
      activationConfidence,
      releaseConfidence,
      maxMisses,
    });

    this.voices = [];
    this.nextId = 1;
    this.frame = 0;
  }

  update(candidates = [], { timestampUs = null } = {}) {
    if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
    this.frame++;

    const normalized = candidates
      .map(normalizeCandidate)
      .filter(Boolean)
      .sort((a, b) => b.excessRatio - a.excessRatio);

    const matches = matchCandidates(this.voices, normalized, this.matchDistanceOctaves);
    const matchedVoiceIndexes = new Set();
    const matchedCandidateIndexes = new Set();

    for (const match of matches) {
      const voice = this.voices[match.voiceIndex];
      const candidate = normalized[match.candidateIndex];
      matchedVoiceIndexes.add(match.voiceIndex);
      matchedCandidateIndexes.add(match.candidateIndex);

      voice.frequencyHz = smoothLogFrequency(
        voice.frequencyHz,
        candidate.frequencyHz,
        this.frequencySmoothing,
      );
      voice.periodSeconds = 1 / voice.frequencyHz;
      voice.strength = lerp(voice.strength, candidate.strength, this.strengthSmoothing);
      voice.excessRatio = lerp(voice.excessRatio, candidate.excessRatio, this.strengthSmoothing);
      voice.phase = smoothPhase(voice.phase, candidate.phase, this.frequencySmoothing);
      voice.confidence = Math.min(1, voice.confidence + this.confidenceAttack);
      voice.ageFrames++;
      voice.matchedFrames++;
      voice.misses = 0;
      voice.lastSeenFrame = this.frame;
      voice.lastTimestampUs = timestampUs;
      voice.active = voice.active || voice.confidence >= this.activationConfidence;
    }

    for (let i = 0; i < this.voices.length; i++) {
      if (matchedVoiceIndexes.has(i)) continue;
      const voice = this.voices[i];
      voice.ageFrames++;
      voice.misses++;
      voice.confidence = Math.max(0, voice.confidence - this.confidenceRelease);
      if (voice.confidence <= this.releaseConfidence) voice.active = false;
    }

    for (let i = 0; i < normalized.length && this.voices.length < this.maxVoices; i++) {
      if (matchedCandidateIndexes.has(i)) continue;
      const candidate = normalized[i];
      this.voices.push({
        id: this.nextId++,
        frequencyHz: candidate.frequencyHz,
        periodSeconds: candidate.periodSeconds,
        strength: candidate.strength,
        excessRatio: candidate.excessRatio,
        phase: candidate.phase,
        confidence: Math.min(1, this.confidenceAttack),
        active: this.confidenceAttack >= this.activationConfidence,
        ageFrames: 1,
        matchedFrames: 1,
        misses: 0,
        createdFrame: this.frame,
        lastSeenFrame: this.frame,
        lastTimestampUs: timestampUs,
      });
    }

    this.voices = this.voices.filter(voice => (
      voice.misses <= this.maxMisses
      && (voice.active || voice.confidence > this.releaseConfidence)
    ));

    return this.snapshot();
  }

  snapshot() {
    return this.voices
      .map(voice => ({ ...voice }))
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return a.id - b.id;
      });
  }

  reset() {
    this.voices = [];
    this.nextId = 1;
    this.frame = 0;
  }
}

function normalizeCandidate(candidate) {
  if (!candidate || !(candidate.frequencyHz > 0)) return null;
  const strength = Number.isFinite(candidate.strength)
    ? candidate.strength
    : Number.isFinite(candidate.recentPower) ? candidate.recentPower : 0;
  return {
    frequencyHz: candidate.frequencyHz,
    periodSeconds: candidate.periodSeconds > 0 ? candidate.periodSeconds : 1 / candidate.frequencyHz,
    strength,
    excessRatio: Number.isFinite(candidate.excessRatio) ? candidate.excessRatio : 0,
    phase: Number.isFinite(candidate.phase) ? candidate.phase : 0,
  };
}

function matchCandidates(voices, candidates, maxDistanceOctaves) {
  const pairs = [];
  for (let voiceIndex = 0; voiceIndex < voices.length; voiceIndex++) {
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const distance = Math.abs(Math.log2(candidates[candidateIndex].frequencyHz / voices[voiceIndex].frequencyHz));
      if (distance <= maxDistanceOctaves) pairs.push({ voiceIndex, candidateIndex, distance });
    }
  }

  pairs.sort((a, b) => a.distance - b.distance);
  const usedVoices = new Set();
  const usedCandidates = new Set();
  const matches = [];
  for (const pair of pairs) {
    if (usedVoices.has(pair.voiceIndex) || usedCandidates.has(pair.candidateIndex)) continue;
    usedVoices.add(pair.voiceIndex);
    usedCandidates.add(pair.candidateIndex);
    matches.push(pair);
  }
  return matches;
}

function smoothLogFrequency(current, next, amount) {
  if (!(current > 0)) return next;
  return 2 ** lerp(Math.log2(current), Math.log2(next), amount);
}

function smoothPhase(current, next, amount) {
  const x = (1 - amount) * Math.cos(current) + amount * Math.cos(next);
  const y = (1 - amount) * Math.sin(current) + amount * Math.sin(next);
  return Math.atan2(y, x);
}

function lerp(a, b, amount) {
  return a + (b - a) * amount;
}

module.exports = {
  VoiceTracker,
  matchCandidates,
  smoothLogFrequency,
  smoothPhase,
};
