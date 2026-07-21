const express    = require('express');
const { WebSocketServer } = require('ws');
const https      = require('https');
const fs         = require('fs');
const os         = require('os');
const dgram      = require('dgram');
const { execSync } = require('child_process');
const { PcmAnalyzer } = require('./audio-analysis');

// ─── SSL ─────────────────────────────────────────────────────────────────────

const certBase = '/var/lib/tailscale/certs/adrian-pi.tailc1f637.ts.net';

let sslOptions;
try {
  sslOptions = {
    key:  fs.readFileSync(`${certBase}.key`),
    cert: fs.readFileSync(`${certBase}.crt`)
  };
  console.log('Using Tailscale HTTPS certificate');
} catch (e) {
  sslOptions = {
    key:  fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
  };
  console.log('Using self-signed certificate');
}

// ─── Express + WebSocket ──────────────────────────────────────────────────────

const app    = express();
const server = https.createServer(sslOptions, app);
const wss    = new WebSocketServer({ server });

app.use(express.static('public'));
app.use(express.json());
app.get('/mic.html', (req, res) => res.redirect(308, '/mic/'));
app.get('/visualizer.html', (req, res) => res.redirect(308, `/visualizer/?${req.url.split('?')[1] || ''}`));
app.use('/mic',   express.static('../mic'));
app.use('/moire', express.static('../moire'));
app.use('/visualizer', express.static('../visualizer'));
app.use('/pcm', express.static('../pcm'));

require('dotenv').config();
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// ─── State ────────────────────────────────────────────────────────────────────

const state = { distance: 0, rate: 0 };
const sourceNames = new Map();
const audioCapabilities = new Map();

// ─── OSC encoding helpers ─────────────────────────────────────────────────────

function encodeOSCString(str) {
  const buf = Buffer.alloc(Math.ceil((str.length + 1) / 4) * 4);
  buf.write(str, 0, 'ascii');
  return buf;
}
function encodeOSCFloat(f) {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(f, 0);
  return buf;
}
function encodeOSCInt(i) {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(i, 0);
  return buf;
}

function buildOSCMessage(address, ...args) {
  const addrBuf = encodeOSCString(address);
  let typeTags  = ',';
  const argBufs = [];
  for (const arg of args) {
    if (typeof arg === 'number' && Number.isInteger(arg)) {
      typeTags += 'i'; argBufs.push(encodeOSCInt(arg));
    } else if (typeof arg === 'number') {
      typeTags += 'f'; argBufs.push(encodeOSCFloat(arg));
    } else if (typeof arg === 'string') {
      typeTags += 's'; argBufs.push(encodeOSCString(arg));
    }
  }
  return Buffer.concat([addrBuf, encodeOSCString(typeTags), ...argBufs]);
}

function parseOSCMessage(buf) {
  try {
    let offset = 0;
    function readString() {
      const end = buf.indexOf(0, offset);
      const str = buf.slice(offset, end).toString('ascii');
      offset = Math.ceil((end + 1) / 4) * 4;
      return str;
    }
    const address  = readString();
    const typeTags = readString();
    const args     = [];
    for (let i = 1; i < typeTags.length; i++) {
      const tag = typeTags[i];
      if      (tag === 'f') { args.push(buf.readFloatBE(offset));  offset += 4; }
      else if (tag === 'i') { args.push(buf.readInt32BE(offset));   offset += 4; }
      else if (tag === 's') { args.push(readString()); }
      else if (tag === 'd') { args.push(buf.readDoubleBE(offset));  offset += 8; }
    }
    return { address, args };
  } catch (e) { return null; }
}

function parseOSCPacket(buf) {
  if (buf.length < 8 || buf.toString('ascii', 0, 8) !== '#bundle\0') {
    const message = parseOSCMessage(buf);
    return message ? [message] : [];
  }

  const messages = [];
  let offset = 16; // bundle marker plus 8-byte timetag
  while (offset + 4 <= buf.length) {
    const size = buf.readInt32BE(offset);
    offset += 4;
    if (size <= 0 || offset + size > buf.length) return [];
    messages.push(...parseOSCPacket(buf.subarray(offset, offset + size)));
    offset += size;
  }
  return offset === buf.length ? messages : [];
}

// ─── SuperCollider OSC sender ─────────────────────────────────────────────────

const scSocket = dgram.createSocket('udp4');

function sendToSC(address, ...args) {
  try { scSocket.send(buildOSCMessage(address, ...args), 57110, '127.0.0.1'); } catch (e) {}
}

// ─── OSC client registry ──────────────────────────────────────────────────────

const OSC_OUT_PORT = 9000;
const OSC_IN_PORT  = 5005;
const PCM_IN_PORT  = 5007;

const oscReceiveClients = new Set();

const oscOutSocket = dgram.createSocket('udp4');

function sendOSCToClient(ip, address, ...args) {
  try { oscOutSocket.send(buildOSCMessage(address, ...args), OSC_OUT_PORT, ip); } catch (e) {}
}

function sendOSCPacketToClients(packet) {
  for (const ip of oscReceiveClients) {
    try { oscOutSocket.send(packet, OSC_OUT_PORT, ip); } catch (e) {}
  }
}

function broadcastOSC(data) {
  if (oscReceiveClients.size === 0) return;

  if (data.type === 'osc' || data.type === 'json') {
    const addr = `/${data.device}`;
    const norm = (data.min != null && data.max != null && data.max !== data.min)
      ? Math.max(0, Math.min(1, (data.value - data.min) / (data.max - data.min)))
      : Math.max(0, Math.min(1, data.value ?? 0));
    for (const ip of oscReceiveClients) sendOSCToClient(ip, addr, parseFloat(data.value), parseFloat(norm));

  } else if (data.type === 'midi') {
    const dev = (data.device || 'midi').replace(/\W+/g, '_');
    if (data.msgType === 'cc') {
      const norm = data.value / 127;
      const addr = `/midi/${dev}/ch${data.channel}/cc${data.cc}`;
      for (const ip of oscReceiveClients) sendOSCToClient(ip, addr, parseFloat(norm), parseInt(data.value));
    } else if (data.msgType === 'noteon') {
      const addr = `/midi/${dev}/ch${data.channel}/n${data.note}`;
      for (const ip of oscReceiveClients) sendOSCToClient(ip, addr, parseInt(data.velocity));
    }
  }
}

// ─── WebSocket broadcast ──────────────────────────────────────────────────────

function broadcast(data) {
  const json = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(json);
  });
  broadcastOSC(data);
}

function broadcastSignalBatch(signals) {
  const json = JSON.stringify({ type: 'signal_batch', signals });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(json);
  });
  for (const signal of signals) broadcastOSC(signal);
}

function broadcastSampleBatch(batch, oscPacket) {
  const json = JSON.stringify(batch);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(json);
  });
  if (oscReceiveClients.size > 0) sendOSCPacketToClients(oscPacket);
  try { scSocket.send(oscPacket, 57110, '127.0.0.1'); } catch (e) {}
}

function decodeScalarBatch(messages, senderIp) {
  const streams = [];
  let packetSequence = null;
  let sendTimeUs = null;
  for (const msg of messages) {
    const parts = msg.address.split('/').filter(Boolean);
    if (parts[0] !== 'batch' || parts.length < 3 || msg.args.length < 6) continue;
    const name = parts[1];
    const param = parts.slice(2).join('/');
    const messagePacketSequence = msg.args[0];
    const messageSendTimeUs = msg.args[1];
    const unit = typeof msg.args[2] === 'string' ? msg.args[2] : '';
    if (!Number.isFinite(messagePacketSequence) || !Number.isFinite(messageSendTimeUs) ||
        (msg.args.length - 3) % 3 !== 0) continue;
    packetSequence ??= messagePacketSequence;
    sendTimeUs ??= messageSendTimeUs;

    const samples = [];
    for (let i = 3; i < msg.args.length; i += 3) {
      const sequence = msg.args[i];
      const timeUs = messageSendTimeUs + msg.args[i + 1];
      const value = msg.args[i + 2];
      if (Number.isFinite(sequence) && Number.isFinite(timeUs) && Number.isFinite(value)) {
        samples.push([sequence, timeUs, value]);
      }
    }
    if (samples.length > 0) {
      sourceNames.set(senderIp, name);
      streams.push({ device: `osc/${name}/${param}`, name, param, unit, samples });
    }
  }

  if (streams.length === 0) return null;
  return {
    type: 'sample_batch', source: senderIp,
    packetSequence, sendTimeUs, streams
  };
}

// ─── OSC inbound listener ─────────────────────────────────────────────────────

const oscInSocket = dgram.createSocket('udp4');

oscInSocket.on('message', (buf, rinfo) => {
  const rawIp    = rinfo.address.replace(/^::ffff:/, '');
  const senderIp = (rawIp === '127.0.0.1' || rawIp === '::1') ? os.hostname() : rawIp;
  const messages = parseOSCPacket(buf);
  const scalarBatch = decodeScalarBatch(messages, senderIp);
  if (scalarBatch) {
    broadcastSampleBatch(scalarBatch, buf);
    for (const stream of scalarBatch.streams) {
      if (stream.param === 'rms') registerAudioCapability(scalarBatch.source, stream.name);
    }
    return;
  }

  const signals = messages
    .map(msg => routeOSCMessage(msg, senderIp))
    .filter(Boolean);

  if (signals.length === 1) broadcast(signals[0]);
  else if (signals.length > 1) broadcastSignalBatch(signals);
});

function routeOSCMessage(msg, senderIp) {
  const parts = msg.address.split('/').filter(Boolean);

  if (parts[0] === 'sensor' && parts.length >= 3) {
    const name  = parts[1];
    const param = parts[2];
    const value = msg.args[0];
    const min   = msg.args[1] ?? undefined;
    const max   = msg.args[2] ?? undefined;
    const key   = `osc/${name}/${param}`;

    const signal = {
      type: 'osc',
      device: key,
      name, param, value,
      source: senderIp,
      enabled: true,
      ...(min !== undefined && { min }),
      ...(max !== undefined && { max })
    };
    sendToSC(msg.address, ...msg.args);
    return signal;

  } else {
    const value = msg.args[0];
    const min   = msg.args[1] ?? undefined;
    const max   = msg.args[2] ?? undefined;
    const key   = `osc/${senderIp}${msg.address}`;

    const signal = {
      type: 'osc',
      device: key,
      value: typeof value === 'number' ? value : 0,
      source: senderIp,
      enabled: true,
      ...(min !== undefined && { min }),
      ...(max !== undefined && { max })
    };
    sendToSC(msg.address, ...msg.args);
    return signal;
  }
}

oscInSocket.bind(OSC_IN_PORT, '0.0.0.0', () => {
  console.log(`OSC inbound listening on port ${OSC_IN_PORT}`);
});

// ─── MIDI UDP receiver — from controllers/main.py on port 5006 ───────────────

const midiSocket = dgram.createSocket('udp4');

midiSocket.on('message', (msg, rinfo) => {
  const separator = msg.indexOf('|'.charCodeAt(0));
  if (separator === -1) return;

  const device    = msg.slice(0, separator).toString();
  const midiBytes = [...msg.slice(separator + 1)];
  if (midiBytes.length < 3) return;

  const status  = midiBytes[0];
  const msgType = status & 0xF0;
  const channel = (status & 0x0F) + 1;

  let decoded = { type: 'midi', device: `midi/${device}`, channel, raw: midiBytes, source: os.hostname() };

  if      (msgType === 0xB0) { decoded.msgType = 'cc';        decoded.cc   = midiBytes[1]; decoded.value    = midiBytes[2]; }
  else if (msgType === 0x90) { decoded.msgType = 'noteon';    decoded.note = midiBytes[1]; decoded.velocity = midiBytes[2]; }
  else if (msgType === 0x80) { decoded.msgType = 'noteoff';   decoded.note = midiBytes[1]; decoded.velocity = midiBytes[2]; }
  else if (msgType === 0xE0) { decoded.msgType = 'pitchbend'; decoded.value = (midiBytes[2] << 7) | midiBytes[1]; }

  broadcast(decoded);
});

midiSocket.bind(5006, '127.0.0.1', () => {
  console.log('MIDI UDP listening on port 5006');
});

// ─── Raw PCM UDP receiver — subscription-only WebSocket forwarding ──────────

const pcmSocket = dgram.createSocket('udp4');
const pcmStreams = new Map();
const pcmAnalyzers = new Map();
const PCM_MAX_WS_BACKLOG = 256 * 1024;

function pcmDeviceFor(ip) {
  return `pcm/${ip}/audio`;
}

function registerAudioCapability(source, name = sourceNames.get(source) || source) {
  const device = pcmDeviceFor(source);
  let capability = audioCapabilities.get(device);
  if (!capability) {
    capability = {
      type: 'audio', device, source, name, param: 'audio',
      sampleRate: 16000, available: false, enabled: true
    };
    audioCapabilities.set(device, capability);
    broadcast(capability);
  } else if (name !== source && capability.name !== name) {
    capability.name = name;
  }
  return capability;
}

pcmSocket.on('message', (packet, rinfo) => {
  if (packet.length < 32 || packet.toString('ascii', 0, 4) !== 'ESAU') return;
  const version = packet.readUInt8(4);
  const channels = packet.readUInt8(5);
  const bitsPerSample = packet.readUInt8(6);
  const sequence = packet.readUInt32LE(8);
  const sampleRate = packet.readUInt32LE(20);
  const sampleCount = packet.readUInt16LE(24);
  const headerBytes = packet.readUInt16LE(26);
  if (version !== 1 || channels !== 1 || bitsPerSample !== 16 ||
      headerBytes < 32 || headerBytes + sampleCount * 2 !== packet.length) return;

  const ip = rinfo.address.replace(/^::ffff:/, '');
  const device = pcmDeviceFor(ip);
  const previous = pcmStreams.get(device);
  const missing = previous && sequence > previous.sequence + 1
    ? previous.missing + sequence - previous.sequence - 1
    : previous?.missing || 0;
  const now = Date.now();
  const stream = {
    device, source: ip, sequence, missing, sampleRate, sampleCount,
    packets: (previous?.packets || 0) + 1, lastSeen: now,
    announcedAt: previous?.announcedAt || 0
  };
  const capability = registerAudioCapability(ip);
  capability.available = true;
  capability.sampleRate = sampleRate;
  if (!previous || now - stream.announcedAt >= 1000) {
    stream.announcedAt = now;
    broadcast({ ...capability, available: true, packets: stream.packets, missing, value: sampleRate });
  }
  pcmStreams.set(device, stream);

  let analyzer = pcmAnalyzers.get(device);
  if (!analyzer) {
    analyzer = new PcmAnalyzer();
    pcmAnalyzers.set(device, analyzer);
  }
  const analysis = analyzer.pushInt16LE(packet.subarray(headerBytes), sampleRate);
  const name = sourceNames.get(ip);
  if (analysis && name) {
    const signals = ['bass', 'mid', 'high', 'centroid'].map(param => ({
      type: 'osc', device: `osc/${name}/${param}`,
      name, param, source: ip, value: analysis[param],
      min: 0, max: 1, unit: param === 'centroid' ? 'normalized-frequency' : 'normalized-energy',
      ...(param === 'centroid' && { centroidHz: analysis.centroidHz }),
      enabled: true
    }));
    broadcastSignalBatch(signals);
  }

  for (const client of wss.clients) {
    if (client.readyState !== 1 || !client.pcmSubscriptions?.has(device)) continue;
    if (client.bufferedAmount > PCM_MAX_WS_BACKLOG) {
      client.pcmBackpressureDrops = (client.pcmBackpressureDrops || 0) + 1;
      continue;
    }
    client.send(packet, { binary: true });
  }
});

pcmSocket.bind(PCM_IN_PORT, '0.0.0.0', () => {
  console.log(`PCM UDP listening on port ${PCM_IN_PORT}`);
});

setInterval(() => {
  const now = Date.now();
  for (const capability of audioCapabilities.values()) {
    const stream = pcmStreams.get(capability.device);
    if (capability.available && (!stream || now - stream.lastSeen > 1500)) {
      capability.available = false;
      broadcast({ ...capability, available: false, value: 0 });
    }
  }
}, 1000);

// ─── Connection tracking ──────────────────────────────────────────────────────

const connectionsByIp = new Map();
const clientMeta      = new Map();

wss.on('connection', (ws, req) => {
  const rawIp    = (req.headers['x-forwarded-for'] || req.socket.remoteAddress).replace(/^::ffff:/, '');
  const clientIp = (rawIp === '127.0.0.1' || rawIp === '::1') ? os.hostname() : rawIp;

  if (!connectionsByIp.has(clientIp)) connectionsByIp.set(clientIp, new Set());
  connectionsByIp.get(clientIp).add(ws);
  ws.pcmSubscriptions = new Set();

  const net = getNetworkMode();
  ws.send(JSON.stringify({
    type: 'server_info',
    hostname: os.hostname(),
    platform: os.platform(),
    networkMode: net.mode,
    networkSsid: net.ssid
  }));
  ws.send(JSON.stringify({ type: 'state', state }));
  for (const capability of audioCapabilities.values()) ws.send(JSON.stringify(capability));
  ws.send(JSON.stringify({
    type: 'client_info',
    ip: clientIp,
    tabCount: connectionsByIp.get(clientIp).size,
    oscOutPort:      OSC_OUT_PORT,
    oscInPort:       OSC_IN_PORT,
    oscReceive:      oscReceiveClients.has(clientIp),
    isServerMachine: rawIp === '127.0.0.1' || rawIp === '::1' ||
      Object.values(os.networkInterfaces()).flat().some(i => i?.address === rawIp)
  }));
  broadcastClientStats();

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'osc_toggle_receive') {
        data.enabled ? oscReceiveClients.add(clientIp) : oscReceiveClients.delete(clientIp);
        broadcastClientStats();
        return;
      }

      if (data.type === 'pcm_subscribe' && typeof data.device === 'string') {
        data.enabled === false
          ? ws.pcmSubscriptions.delete(data.device)
          : ws.pcmSubscriptions.add(data.device);
        const stream = pcmStreams.get(data.device);
        ws.send(JSON.stringify({
          type: 'pcm_stream', device: data.device,
          available: Boolean(stream),
          ...(stream || {}),
          backpressureDrops: ws.pcmBackpressureDrops || 0
        }));
        return;
      }

      if (data.type === 'midi') {
        // attach source IP so client can group by section
        data.source = clientIp;
        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === 1) client.send(JSON.stringify(data));
        });
        broadcastOSC(data);
        return;
      }

      if (data.type === 'json') {
        // attach source IP so client can group by section
        data.source = clientIp;
        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === 1) client.send(JSON.stringify(data));
        });
        broadcastOSC(data);
        return;
      }

      if (data.type === 'client_meta') {
        clientMeta.set(clientIp, { os: data.os, connType: data.connType });
        broadcastClientStats();
      }

    } catch (e) {
      console.error('WebSocket message error:', e);
    }
  });

  ws.on('close', () => {
    connectionsByIp.get(clientIp)?.delete(ws);
    if (connectionsByIp.get(clientIp)?.size === 0) {
      connectionsByIp.delete(clientIp);
      oscReceiveClients.delete(clientIp);
    }
    broadcastClientStats();
  });
});

function broadcastClientStats() {
  for (const [ip, conns] of connectionsByIp) {
    for (const conn of conns) {
      if (conn.readyState !== 1) conns.delete(conn);
    }
    if (conns.size === 0) connectionsByIp.delete(ip);
  }

  const uniqueIps = [...connectionsByIp.keys()].map(ip => ({
    ip,
    tabCount:   connectionsByIp.get(ip).size,
    oscReceive: oscReceiveClients.has(ip),
    ...( clientMeta.get(ip) || {} )
  }));

  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      for (const [ip, conns] of connectionsByIp) {
        if (conns.has(client)) {
          client.send(JSON.stringify({
            type:       'client_count',
            count:      uniqueIps.length,
            tabCount:   conns.size,
            allClients: uniqueIps
          }));
          break;
        }
      }
    }
  });
}

// ─── Network mode detection ───────────────────────────────────────────────────

function getNetworkMode() {
  try {
    execSync("nmcli -t -f active,ssid dev wifi 2>/dev/null").toString();
    const result = execSync('systemctl is-active hostapd 2>/dev/null').toString().trim();
    if (result === 'active') {
      const ssid = execSync("grep '^ssid=' /etc/hostapd/hostapd.conf 2>/dev/null")
        .toString().trim().replace('ssid=', '');
      return { mode: 'ap', ssid };
    }
  } catch {}
  try {
    const ssid = execSync("nmcli -t -f active,ssid dev wifi 2>/dev/null | grep '^yes' | cut -d: -f2")
      .toString().trim();
    return { mode: 'wifi', ssid: ssid || 'unknown' };
  } catch {}
  return { mode: 'unknown', ssid: '' };
}

// ─── HTTP routes ──────────────────────────────────────────────────────────────

app.use(express.json());
app.get('/api/status', (req, res) => res.json({ ok: true, hostname: os.hostname() }));

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Router running on port ${PORT}`);
  console.log(`OSC inbound on port ${OSC_IN_PORT} (all reachable senders)`);
  console.log(`OSC outbound on port ${OSC_OUT_PORT} (registered receive clients)`);
});

// ─── Supabase polling ─────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');
const WebSocket        = require('ws');
const supabase         = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { transport: WebSocket }
});

setInterval(async () => {
  try {
    const { data, error } = await supabase
      .from('readings')
      .select('device_id, ts, temp_c, temp_f, rh')
      .order('ts', { ascending: false })
      .limit(1);

    if (error) { console.error('Supabase error:', error.message); return; }

    if (data?.[0]) {
      broadcast({ type: 'json', device: 'json/esp32-am2320/temp_c', value: data[0].temp_c, source: os.hostname(), min: 0, max: 50 });
      broadcast({ type: 'json', device: 'json/esp32-am2320/temp_f', value: data[0].temp_f, source: os.hostname(), min: 32, max: 122 });
      broadcast({ type: 'json', device: 'json/esp32-am2320/rh',     value: data[0].rh,     source: os.hostname(), min: 0, max: 100 });
    }
  } catch (e) {
    console.error('Error fetching from Supabase:', e.message);
  }
}, 2000);
