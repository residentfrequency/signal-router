'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ingestRouterMessage, midiStreamId } = require('../resident-live');

function fakeRegistry() {
  return {
    calls: [],
    ingest(...args) { this.calls.push(['ingest', ...args]); return true; },
    ingestBatch(...args) { this.calls.push(['batch', ...args]); return args[1].length; },
  };
}

test('builds stable MIDI stream identifiers', () => {
  assert.equal(midiStreamId({ device: 'controller', msgType: 'cc', channel: 2, cc: 7 }), 'controller/ch2/cc7');
  assert.equal(midiStreamId({ device: 'controller', msgType: 'pitchbend', channel: 3 }), 'controller/ch3/pb');
  assert.equal(midiStreamId({ device: 'controller', msgType: 'noteon', channel: 1 }), null);
});

test('ingests every stream in a timestamped sample batch', () => {
  const registry = fakeRegistry();
  const values = [];
  const count = ingestRouterMessage(registry, {
    type: 'sample_batch',
    streams: [
      { device: 'osc/sky/temp', samples: [[1, 10, 20], [2, 20, 21]] },
      { name: 'sky', param: 'humidity', samples: [[1, 10, 50]] },
    ],
  }, 999, (device, value) => values.push([device, value]));

  assert.equal(count, 3);
  assert.deepEqual(registry.calls, [
    ['batch', 'osc/sky/temp', [[1, 10, 20], [2, 20, 21]]],
    ['batch', 'osc/sky/humidity', [[1, 10, 50]]],
  ]);
  assert.deepEqual(values, [
    ['osc/sky/temp', 21],
    ['osc/sky/humidity', 50],
  ]);
});

test('ingests scalar OSC and MIDI values', () => {
  const registry = fakeRegistry();
  const values = [];
  assert.equal(ingestRouterMessage(registry, {
    type: 'osc', device: 'osc/source/value', timeUs: 123, sequence: 4, value: 0.5,
  }, 999, (device, value) => values.push([device, value])), 1);
  assert.equal(ingestRouterMessage(registry, {
    type: 'midi', device: 'controller', msgType: 'cc', channel: 1, cc: 74, value: 64,
  }, 999), 1);

  assert.deepEqual(registry.calls, [
    ['ingest', 'osc/source/value', 123, 0.5, 4],
    ['ingest', 'controller/ch1/cc74', 999, 64],
  ]);
  assert.deepEqual(values, [['osc/source/value', 0.5]]);
});

test('recursively ingests signal batches and ignores notes', () => {
  const registry = fakeRegistry();
  const count = ingestRouterMessage(registry, {
    type: 'signal_batch',
    signals: [
      { type: 'json', device: 'json/lfo', value: 0.2 },
      { type: 'midi', device: 'keys', msgType: 'noteon', channel: 1, note: 60, velocity: 100 },
    ],
  }, 500);

  assert.equal(count, 1);
  assert.deepEqual(registry.calls, [['ingest', 'json/lfo', 500, 0.2, undefined]]);
});
