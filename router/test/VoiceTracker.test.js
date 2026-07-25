'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  VoiceTracker,
  matchCandidates,
  smoothLogFrequency,
  smoothPhase,
} = require('../VoiceTracker');

function candidate(frequencyHz, excessRatio = 4, strength = excessRatio, phase = 0) {
  return {
    frequencyHz,
    periodSeconds: 1 / frequencyHz,
    excessRatio,
    strength,
    phase,
  };
}

test('matches nearby candidates one-to-one by octave distance', () => {
  const voices = [{ frequencyHz: 1 }, { frequencyHz: 0.25 }];
  const candidates = [candidate(0.27), candidate(0.95), candidate(2)];
  const matches = matchCandidates(voices, candidates, 0.2);
  const pairs = matches
    .map(({ voiceIndex, candidateIndex }) => [voiceIndex, candidateIndex])
    .sort((a, b) => a[0] - b[0]);

  assert.deepEqual(pairs, [
    [0, 1],
    [1, 0],
  ]);
});

test('a recurring candidate grows into an active persistent voice', () => {
  const tracker = new VoiceTracker({
    confidenceAttack: 0.2,
    activationConfidence: 0.5,
    confidenceRelease: 0.1,
  });

  let voices;
  for (let frame = 0; frame < 3; frame++) voices = tracker.update([candidate(0.2)]);

  assert.equal(voices.length, 1);
  assert.equal(voices[0].id, 1);
  assert.equal(voices[0].active, true);
  assert.ok(voices[0].confidence >= 0.5);
  assert.equal(voices[0].matchedFrames, 3);
  assert.equal(voices[0].ageFrames, 3);
});

test('nearby frequency drift preserves identity and is smoothed logarithmically', () => {
  const tracker = new VoiceTracker({
    matchDistanceOctaves: 0.3,
    frequencySmoothing: 0.5,
    confidenceAttack: 1,
    activationConfidence: 0.5,
  });

  tracker.update([candidate(1)]);
  const voices = tracker.update([candidate(1.21)]);

  assert.equal(voices.length, 1);
  assert.equal(voices[0].id, 1);
  assert.ok(voices[0].frequencyHz > 1 && voices[0].frequencyHz < 1.21);
  assert.ok(Math.abs(voices[0].frequencyHz - Math.sqrt(1.21)) < 1e-12);
});

test('hysteresis retains a voice through brief misses then releases it', () => {
  const tracker = new VoiceTracker({
    confidenceAttack: 0.5,
    confidenceRelease: 0.2,
    activationConfidence: 0.5,
    releaseConfidence: 0.1,
    maxMisses: 5,
  });

  let voices = tracker.update([candidate(0.5)]);
  assert.equal(voices[0].active, true);

  voices = tracker.update([]);
  assert.equal(voices.length, 1);
  assert.equal(voices[0].active, true);
  assert.equal(voices[0].misses, 1);

  voices = tracker.update([]);
  assert.equal(voices.length, 1);
  assert.equal(voices[0].active, false);

  voices = tracker.update([]);
  assert.deepEqual(voices, []);
});

test('unmatched candidates fill only the configured voice capacity', () => {
  const tracker = new VoiceTracker({
    maxVoices: 2,
    confidenceAttack: 1,
    activationConfidence: 0.5,
  });

  const voices = tracker.update([
    candidate(1, 3),
    candidate(0.5, 8),
    candidate(0.25, 5),
  ]);

  assert.equal(voices.length, 2);
  assert.deepEqual(voices.map(voice => voice.frequencyHz), [0.5, 0.25]);
});

test('phase smoothing follows the shortest circular direction', () => {
  const phase = smoothPhase(Math.PI - 0.1, -Math.PI + 0.1, 0.5);
  assert.ok(Math.abs(Math.abs(phase) - Math.PI) < 1e-12);
});

test('reset clears voices and restarts stable identifiers', () => {
  const tracker = new VoiceTracker({ confidenceAttack: 1, activationConfidence: 0.5 });
  tracker.update([candidate(1)]);
  tracker.reset();
  const voices = tracker.update([candidate(0.5)]);

  assert.equal(voices.length, 1);
  assert.equal(voices[0].id, 1);
  assert.equal(tracker.frame, 1);
});

test('log-frequency interpolation uses octave space', () => {
  assert.equal(smoothLogFrequency(1, 4, 0.5), 2);
});