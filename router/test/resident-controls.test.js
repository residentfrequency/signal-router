'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../resident-live-controls.js'),
  'utf8',
);

test('voices page groups global MIDI and beat controls without the old title', () => {
  assert.doesNotMatch(source, /BEAT CC RANGE/);
  assert.match(source, /controls\.appendChild\(midiPanel\)/);
  assert.match(source, /controls\.appendChild\(globalBeatPanel\)/);
});

test('voices outputs and stream controls follow analyzer readiness', () => {
  assert.match(source, /const anyReady = \[\.\.\.messages\.values\(\)\]\.some/);
  assert.match(source, /midiEnable\.disabled = !anyReady/);
  assert.match(source, /group\.button\.disabled = !deviceReady/);
  assert.match(source, /row\.querySelectorAll\('input,select'\)/);
  assert.match(source, /control\.disabled = !ready/);
});

test('stream Notes send state also mutes that stream in browser audio', () => {
  assert.match(source, /filter\(voice => streamSettings\(voice\.streamId\)\.noteEnabled\)/);
  assert.match(source, /const unfilteredSyncAudio = syncAudio/);
});
