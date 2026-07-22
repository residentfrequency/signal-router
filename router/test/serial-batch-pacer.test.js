const test = require('node:test');
const assert = require('node:assert/strict');
const { SerialBatchPacer } = require('../serial-batch-pacer');

test('paces burst-delivered serial batches from source timestamps', () => {
  const scheduled = [];
  const delivered = [];
  const pacer = new SerialBatchPacer(batch => delivered.push(batch.packetSequence), {
    startupBufferMs: 200,
    schedule: (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; },
    cancel: () => {}
  });
  pacer.push({ packetSequence: 1, sendTimeUs: 1_000_000 });
  pacer.push({ packetSequence: 2, sendTimeUs: 1_063_000 });
  pacer.push({ packetSequence: 3, sendTimeUs: 1_126_000 });

  assert.equal(scheduled[0].delay, 200);
  scheduled.shift().fn();
  assert.deepEqual(delivered, [1]);
  assert.equal(scheduled[0].delay, 63);
  scheduled.shift().fn();
  assert.deepEqual(delivered, [1, 2]);
  assert.equal(scheduled[0].delay, 63);
});

test('resets queued timing when a device timestamp restarts', () => {
  const scheduled = [];
  const pacer = new SerialBatchPacer(() => {}, {
    schedule: (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; },
    cancel: () => {}
  });
  pacer.push({ packetSequence: 50, sendTimeUs: 5_000_000 });
  pacer.push({ packetSequence: 1, sendTimeUs: 100_000 });
  assert.equal(pacer.queue.length, 1);
  assert.equal(pacer.queue[0].packetSequence, 1);
});
