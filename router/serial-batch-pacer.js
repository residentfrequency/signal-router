class SerialBatchPacer {
  constructor(deliver, options = {}) {
    this.deliver = deliver;
    this.startupBufferMs = options.startupBufferMs ?? 250;
    this.maxIntervalMs = options.maxIntervalMs ?? 250;
    this.maxQueue = options.maxQueue ?? 256;
    this.schedule = options.schedule ?? ((fn, delay) => setTimeout(fn, delay));
    this.cancel = options.cancel ?? clearTimeout;
    this.queue = [];
    this.timer = null;
    this.lastQueuedTimeUs = null;
  }

  push(batch) {
    if (this.lastQueuedTimeUs !== null && batch.sendTimeUs <= this.lastQueuedTimeUs) this.reset();
    this.lastQueuedTimeUs = batch.sendTimeUs;
    this.queue.push(batch);
    if (this.queue.length > this.maxQueue) this.queue.splice(0, this.queue.length - this.maxQueue);
    if (this.timer === null) this.timer = this.schedule(() => this.drain(), this.startupBufferMs);
  }

  drain() {
    this.timer = null;
    const current = this.queue.shift();
    if (!current) return;
    this.deliver(current);
    const next = this.queue[0];
    if (!next) return;
    const intervalMs = Math.max(1, Math.min(this.maxIntervalMs,
      (next.sendTimeUs - current.sendTimeUs) / 1000));
    this.timer = this.schedule(() => this.drain(), intervalMs);
  }

  reset() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.lastQueuedTimeUs = null;
  }
}

module.exports = { SerialBatchPacer };
