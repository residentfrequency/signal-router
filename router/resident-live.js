'use strict';

const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');
const { ResidentStreamRegistry } = require('./ResidentStreamRegistry');

const ROUTER_URL = process.env.RESIDENT_ROUTER_URL || 'wss://127.0.0.1:3000';
const PORT = Number(process.env.RESIDENT_PORT || 3001);
const ANALYSIS_INTERVAL_MS = Number(process.env.RESIDENT_ANALYSIS_INTERVAL_MS || 1000);

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
    return data.signals.reduce((count, signal) => (
      count + ingestRouterMessage(registry, signal, nowTimestampUs)
    ), 0);
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
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Resident Voices</title><style>
*{box-sizing:border-box}body{margin:0;padding:20px;background:#0a0a0a;color:#00ff88;font:14px monospace}h1{font-size:15px;letter-spacing:.2em;opacity:.65}.status{opacity:.5;margin:8px 0 18px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px;border-bottom:1px solid #1b1b1b;vertical-align:top}th{font-size:11px;opacity:.4}.device{max-width:34vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.waiting{opacity:.35}.voice{display:block;color:#aaffd4;margin-bottom:3px}.voice.inactive{opacity:.35}
</style></head><body><h1>RESIDENT FREQUENCY VOICES</h1><div class="status" id="status">connecting…</div><table><thead><tr><th>STREAM</th><th>STATUS</th><th>COVERAGE</th><th>VOICES</th></tr></thead><tbody id="rows"></tbody></table>
<script>
const rows=new Map();const body=document.getElementById('rows');const status=document.getElementById('status');
function number(value,digits=3){return Number.isFinite(value)?value.toFixed(digits):'—'}
function render(message){let row=rows.get(message.device);if(!row){row=document.createElement('tr');row.innerHTML='<td class="device"></td><td></td><td></td><td></td>';body.appendChild(row);rows.set(message.device,row)}const cells=row.children;cells[0].textContent=message.device;cells[0].title=message.device;cells[1].textContent=message.ready?'ready':(message.reason||'waiting');cells[1].className=message.ready?'':'waiting';cells[2].textContent=number(message.coverage,2);const active=(message.voices||[]).filter(v=>v.active);const shown=active.length?active:(message.voices||[]).slice(0,3);cells[3].innerHTML=shown.length?shown.map(v=>'<span class="voice '+(v.active?'':'inactive')+'">#'+v.id+' '+number(v.frequencyHz,4)+' Hz · '+number(v.periodSeconds,2)+' s · conf '+number(v.confidence,2)+'</span>').join(''):'<span class="waiting">none</span>'}
const ws=new WebSocket('ws://'+location.host);ws.onopen=()=>status.textContent='live · '+location.host;ws.onclose=()=>status.textContent='disconnected';ws.onmessage=e=>{const data=JSON.parse(e.data);if(data.type==='resident_voices')render(data)};
</script></body></html>`;
}

function startResidentLive({
  routerUrl = ROUTER_URL,
  port = PORT,
  analysisIntervalMs = ANALYSIS_INTERVAL_MS,
  registry = new ResidentStreamRegistry(),
} = {}) {
  const latest = new Map();
  const server = http.createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/resident/') {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page());
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', client => {
    for (const message of latest.values()) client.send(JSON.stringify(message));
  });

  let routerSocket;
  let reconnectTimer;
  const connect = () => {
    routerSocket = new WebSocket(routerUrl, { rejectUnauthorized: false });
    routerSocket.on('message', raw => {
      try { ingestRouterMessage(registry, JSON.parse(raw.toString())); } catch {}
    });
    routerSocket.on('close', () => {
      reconnectTimer = setTimeout(connect, 2000);
    });
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
  return {
    server,
    registry,
    close() {
      clearInterval(analysisTimer);
      clearTimeout(reconnectTimer);
      routerSocket?.close();
      wss.close();
      server.close();
    },
  };
}

if (require.main === module) startResidentLive();

module.exports = { ingestRouterMessage, midiStreamId, startResidentLive };
