'use strict';

const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');
const { ResidentStreamRegistry } = require('./ResidentStreamRegistry');

const ROUTER_URL = process.env.RESIDENT_ROUTER_URL || 'wss://127.0.0.1:3000';
const PORT = Number(process.env.RESIDENT_PORT || 3001);
const ANALYSIS_INTERVAL_MS = Number(process.env.RESIDENT_ANALYSIS_INTERVAL_MS || 1000);
const PAGE_GZIP_BASE64 = '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';

function midiStreamId(data) {
  const device = data.device || 'midi';
  if (data.msgType === 'cc') return `${device}/ch${data.channel}/cc${data.cc}`;
  if (data.msgType === 'pitchbend') return `${device}/ch${data.channel}/pb`;
  return null;
}

function ingestRouterMessage(registry, data, nowTimestampUs = Date.now() * 1000) {
  if (!data || typeof data !== 'object') return 0;
  if (data.type === 'sample_batch' && Array.isArray(data.streams)) {
    let count = 0;
    for (const stream of data.streams) {
      const streamId = stream.device || `osc/${stream.name}/${stream.param}`;
      count += registry.ingestBatch(streamId, stream.samples || []);
    }
    return count;
  }
  if (data.type === 'signal_batch' && Array.isArray(data.signals)) {
    return data.signals.reduce((count, signal) => count + ingestRouterMessage(registry, signal, nowTimestampUs), 0);
  }
  if ((data.type === 'osc' || data.type === 'json') && Number.isFinite(Number(data.value))) {
    return registry.ingest(
      data.device,
      Number.isFinite(Number(data.timeUs)) ? Number(data.timeUs) : nowTimestampUs,
      Number(data.value),
      data.sequence,
    ) ? 1 : 0;
  }
  if (data.type === 'midi') {
    const streamId = midiStreamId(data);
    if (!streamId || !Number.isFinite(Number(data.value))) return 0;
    return registry.ingest(streamId, nowTimestampUs, Number(data.value)) ? 1 : 0;
  }
  return 0;
}

function page() {
  return require('zlib').gunzipSync(Buffer.from(PAGE_GZIP_BASE64, 'base64')).toString('utf8');
}


function startResidentLive({ routerUrl = ROUTER_URL, port = PORT, analysisIntervalMs = ANALYSIS_INTERVAL_MS, registry = new ResidentStreamRegistry() } = {}) {
  const latest = new Map();
  const server = http.createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/resident/') return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page());
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', client => { for (const message of latest.values()) client.send(JSON.stringify(message)); });
  let routerSocket; let reconnectTimer;
  const connect = () => {
    routerSocket = new WebSocket(routerUrl, { rejectUnauthorized: false });
    routerSocket.on('message', raw => { try { ingestRouterMessage(registry, JSON.parse(raw.toString())); } catch {} });
    routerSocket.on('close', () => { reconnectTimer = setTimeout(connect, 2000); });
    routerSocket.on('error', () => {});
  };
  connect();
  const analysisTimer = setInterval(() => {
    for (const message of registry.analyzeAll()) {
      latest.set(message.device, message);
      const json = JSON.stringify(message);
      for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(json);
    }
  }, analysisIntervalMs);
  server.listen(port, () => console.log(`Resident voices: http://localhost:${port}/resident/`));
  return { server, registry, close() { clearInterval(analysisTimer); clearTimeout(reconnectTimer); routerSocket?.close(); wss.close(); server.close(); } };
}

if (require.main === module) startResidentLive();
module.exports = { ingestRouterMessage, midiStreamId, startResidentLive };
