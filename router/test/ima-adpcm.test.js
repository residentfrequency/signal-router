const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeImaAdpcm } = require('../ima-adpcm');

test('decodes a packet-independent IMA ADPCM frame', () => {
  const packet = Buffer.alloc(38);
  packet.writeInt16LE(1000, 32);
  packet[34] = 0;
  packet[36] = 0x11;
  packet[37] = 0x11;
  const decoded = decodeImaAdpcm(packet, 5, 36);
  assert.equal(decoded.length, 10);
  assert.equal(decoded.readInt16LE(0), 1000);
  assert.ok(decoded.readInt16LE(8) > 1000);
});
