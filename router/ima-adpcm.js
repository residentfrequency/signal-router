const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8];
const STEP_TABLE = [
  7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,
  73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,
  449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,
  2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,
  7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,
  24623,27086,29794,32767
];

function decodeImaAdpcm(packet, sampleCount, headerBytes) {
  let predictor = packet.readInt16LE(32);
  let index = Math.max(0, Math.min(88, packet.readUInt8(34)));
  const output = Buffer.alloc(sampleCount * 2);
  output.writeInt16LE(predictor, 0);
  for (let i = 1; i < sampleCount; i++) {
    const packed = packet[headerBytes + Math.floor((i - 1) / 2)];
    const code = (i & 1) ? packed & 15 : packed >> 4;
    const step = STEP_TABLE[index];
    let delta = step >> 3;
    if (code & 4) delta += step;
    if (code & 2) delta += step >> 1;
    if (code & 1) delta += step >> 2;
    predictor += code & 8 ? -delta : delta;
    predictor = Math.max(-32768, Math.min(32767, predictor));
    index = Math.max(0, Math.min(88, index + INDEX_TABLE[code & 7]));
    output.writeInt16LE(predictor, i * 2);
  }
  return output;
}

module.exports = { decodeImaAdpcm };
