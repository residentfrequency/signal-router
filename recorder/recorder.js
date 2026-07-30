'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { WebSocket } = require('ws');
const parquet = require('parquetjs-lite');

const PORT = Number(process.env.RF_RECORDER_PORT || 3010);
const ROUTER_URL = process.env.RF_ROUTER_URL || 'wss://adrian-pi:3000';
const DATA_DIR = expandHome(process.env.RF_RECORDING_DIR ||
  '~/Resident Frequency Recordings');
const MAX_BYTES = Number(process.env.RF_RECORDING_MAX_BYTES || 20 * 1024 ** 3);
const MIN_FREE_BYTES = Number(process.env.RF_RECORDING_MIN_FREE_BYTES || 8 * 1024 ** 3);

const schema = new parquet.ParquetSchema({
  device: { type: 'UTF8', compression: 'SNAPPY' },
  source: { type: 'UTF8', compression: 'SNAPPY' },
  parameter: { type: 'UTF8', optional: true, compression: 'SNAPPY' },
  unit: { type: 'UTF8', optional: true, compression: 'SNAPPY' },
  sequence: { type: 'INT64', optional: true, compression: 'SNAPPY' },
  timestamp_us: { type: 'INT64', compression: 'SNAPPY' },
  received_at_us: { type: 'INT64', compression: 'SNAPPY' },
  value: { type: 'DOUBLE', compression: 'SNAPPY' },
});

const state = {
  recording: false,
  connected: false,
  startedAt: null,
  stoppedAt: null,
  stopReason: null,
  totalSamples: 0,
  sessionSamples: 0,
  sessionBytesAtStart: 0,
  diskBytes: 0,
  freeBytes: 0,
  files: 0,
  reconnects: 0,
  lastMessageAt: null,
  error: null,
  streams: new Map(),
};

const writers = new Map();
let routerSocket = null;
let reconnectTimer = null;
let writeQueue = Promise.resolve();
let shuttingDown = false;

function expandHome(value) {
  return value.replace(/^~(?=$|\/)/, os.homedir());
}

function safeName(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function hourKey(date = new Date()) {
  return date.toISOString().slice(0, 13).replace('T', '_');
}

function scanStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let bytes = 0;
  let files = 0;
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else {
        const stat = fs.statSync(filename);
        bytes += stat.size;
        files++;
      }
    }
  };
  visit(DATA_DIR);
  const statfs = fs.statfsSync(DATA_DIR);
  state.diskBytes = bytes;
  state.files = files;
  state.freeBytes = statfs.bavail * statfs.bsize;
}

async function writerFor(source, receivedAtUs) {
  const date = new Date(receivedAtUs / 1000);
  const hour = hourKey(date);
  const key = `${source}:${hour}`;
  let entry = writers.get(key);
  if (entry) return entry;

  for (const [oldKey, oldEntry] of writers) {
    if (oldEntry.source === source && oldEntry.hour !== hour) {
      await closeWriter(oldKey, oldEntry);
    }
  }

  const directory = path.join(DATA_DIR, safeName(source));
  fs.mkdirSync(directory, { recursive: true });
  const base = `${hour}.parquet`;
  const finalPath = path.join(directory, base);
  const workingPath = `${finalPath}.inprogress`;
  const writer = await parquet.ParquetWriter.openFile(schema, workingPath, {
    useDataPageV2: false,
  });
  writer.setRowGroupSize(8192);
  entry = { writer, source, hour, workingPath, finalPath, samples: 0 };
  writers.set(key, entry);
  return entry;
}

async function closeWriter(key, entry) {
  writers.delete(key);
  await entry.writer.close();
  fs.renameSync(entry.workingPath, entry.finalPath);
}

async function closeWriters() {
  for (const [key, entry] of [...writers]) await closeWriter(key, entry);
  scanStorage();
}

function streamStats(device) {
  let stats = state.streams.get(device);
  if (!stats) {
    stats = {
      samples: 0, missing: 0, duplicates: 0, resets: 0,
      nominalSequenceStep: null, lastSequence: null, lastValue: null, lastTimestampUs: null,
    };
    state.streams.set(device, stats);
  }
  return stats;
}

function accountSample(device, sequence, timestampUs, value) {
  const stats = streamStats(device);
  if (Number.isFinite(sequence) && stats.lastSequence !== null) {
    const delta = sequence - stats.lastSequence;
    if (delta === 0) stats.duplicates++;
    else if (delta < 0) stats.resets++;
    else {
      if (stats.nominalSequenceStep === null || delta < stats.nominalSequenceStep) {
        stats.nominalSequenceStep = delta;
      }
      if (stats.nominalSequenceStep === 1 && delta > 1) stats.missing += delta - 1;
    }
  }
  if (Number.isFinite(sequence)) stats.lastSequence = sequence;
  stats.samples++;
  stats.lastValue = value;
  stats.lastTimestampUs = timestampUs;
  state.totalSamples++;
  state.sessionSamples++;
}

async function appendRow(row) {
  if (!state.recording) return;
  if (state.diskBytes >= MAX_BYTES || state.freeBytes <= MIN_FREE_BYTES) {
    state.recording = false;
    state.stoppedAt = new Date().toISOString();
    state.stopReason = state.diskBytes >= MAX_BYTES
      ? 'storage ceiling reached'
      : 'free-space reserve reached';
    await closeWriters();
    return;
  }
  const entry = await writerFor(row.source, row.received_at_us);
  await entry.writer.appendRow(row);
  entry.samples++;
  accountSample(row.device, row.sequence, row.timestamp_us, row.value);
}

async function recordMessage(data) {
  if (!state.recording || !data || typeof data !== 'object') return;
  const receivedAtUs = Date.now() * 1000;
  if (data.type === 'sample_batch' && Array.isArray(data.streams)) {
    for (const stream of data.streams) {
      const device = stream.device || `osc/${stream.name}/${stream.param}`;
      if (!device.startsWith('osc/')) continue;
      const source = stream.name || data.source || device.split('/')[1] || 'unknown';
      for (const sample of stream.samples || []) {
        const sequence = Number(sample[0]);
        const timestampUs = Number(sample[1]);
        const value = Number(sample[2]);
        if (!Number.isFinite(timestampUs) || !Number.isFinite(value)) continue;
        await appendRow({
          device,
          source: String(source),
          parameter: stream.param || device.split('/').at(-1),
          unit: stream.unit || undefined,
          sequence: Number.isFinite(sequence) ? sequence : undefined,
          timestamp_us: timestampUs,
          received_at_us: receivedAtUs,
          value,
        });
      }
    }
    return;
  }
  const signals = data.type === 'signal_batch' ? data.signals : [data];
  for (const signal of signals || []) {
    if (signal?.type !== 'osc' || !Number.isFinite(Number(signal.value))) continue;
    const device = signal.device || `osc/${signal.name}/${signal.param}`;
    await appendRow({
      device,
      source: String(signal.name || signal.source || device.split('/')[1] || 'unknown'),
      parameter: signal.param || device.split('/').at(-1),
      unit: signal.unit || undefined,
      sequence: Number.isFinite(Number(signal.sequence)) ? Number(signal.sequence) : undefined,
      timestamp_us: Number.isFinite(Number(signal.timeUs)) ? Number(signal.timeUs) : receivedAtUs,
      received_at_us: receivedAtUs,
      value: Number(signal.value),
    });
  }
}

function connectRouter() {
  if (shuttingDown || routerSocket) return;
  const socket = new WebSocket(ROUTER_URL, { rejectUnauthorized: false });
  routerSocket = socket;
  socket.on('open', () => {
    state.connected = true;
    state.error = null;
  });
  socket.on('message', (raw, isBinary) => {
    if (isBinary) return;
    state.lastMessageAt = new Date().toISOString();
    let data;
    try { data = JSON.parse(raw.toString()); }
    catch { return; }
    writeQueue = writeQueue.then(() => recordMessage(data)).catch(error => {
      state.error = error.message;
      state.recording = false;
      state.stoppedAt = new Date().toISOString();
      state.stopReason = `write error: ${error.message}`;
      return closeWriters();
    });
  });
  socket.on('close', () => {
    state.connected = false;
    routerSocket = null;
    if (!shuttingDown) {
      state.reconnects++;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectRouter, 2000);
    }
  });
  socket.on('error', error => {
    state.error = error.message;
    socket.close();
  });
}

async function startRecording() {
  if (state.recording) return;
  scanStorage();
  if (state.diskBytes >= MAX_BYTES) throw new Error('storage ceiling already reached');
  if (state.freeBytes <= MIN_FREE_BYTES) throw new Error('free-space reserve already reached');
  state.recording = true;
  state.startedAt = new Date().toISOString();
  state.stoppedAt = null;
  state.stopReason = null;
  state.sessionSamples = 0;
  state.sessionBytesAtStart = state.diskBytes;
  state.error = null;
}

async function stopRecording(reason = 'stopped by user') {
  if (!state.recording && writers.size === 0) return;
  state.recording = false;
  state.stoppedAt = new Date().toISOString();
  state.stopReason = reason;
  await writeQueue;
  await closeWriters();
}

function publicStatus() {
  scanStorage();
  return {
    recording: state.recording,
    connected: state.connected,
    routerUrl: ROUTER_URL,
    dataDirectory: DATA_DIR,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    stopReason: state.stopReason,
    sessionSamples: state.sessionSamples,
    totalSamples: state.totalSamples,
    diskBytes: state.diskBytes,
    sessionBytes: Math.max(0, state.diskBytes - state.sessionBytesAtStart),
    maxBytes: MAX_BYTES,
    freeBytes: state.freeBytes,
    minimumFreeBytes: MIN_FREE_BYTES,
    files: state.files,
    openFiles: writers.size,
    reconnects: state.reconnects,
    lastMessageAt: state.lastMessageAt,
    error: state.error,
    streams: Object.fromEntries([...state.streams].map(([device, stats]) => [device, stats])),
  };
}

const page = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Resident Frequency Recorder</title>
<style>
body{background:#090a0c;color:#d8e5e0;font:14px ui-monospace,SFMono-Regular,Menlo,monospace;margin:24px;max-width:1100px}
h1{font-size:18px;letter-spacing:.12em}button{font:inherit;color:#8fffc4;background:#101713;border:1px solid #315c45;padding:8px 18px;margin-right:8px;cursor:pointer}
button:disabled{opacity:.35;cursor:default}.card{border:1px solid #202a27;background:#0e1211;padding:14px;margin:14px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}.label{color:#75847f;font-size:11px;text-transform:uppercase}.value{margin-top:4px;color:#a9f5d0}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px;border-bottom:1px solid #1d2523}th{color:#75847f;font-size:11px}.good{color:#79f2b2}.bad{color:#ff8d8d}
</style>
<h1>RESIDENT FREQUENCY RECORDER</h1>
<p><button id="start">START RECORDING</button><button id="stop">STOP</button> <span id="state"></span></p>
<div class="card grid" id="summary"></div>
<div class="card"><table><thead><tr><th>STREAM</th><th>SAMPLES</th><th>MISSING</th><th>DUPLICATES</th><th>LAST VALUE</th></tr></thead><tbody id="streams"></tbody></table></div>
<script>
const startButton=document.getElementById('start');
const stopButton=document.getElementById('stop');
const stateLabel=document.getElementById('state');
const summaryElement=document.getElementById('summary');
const streamsElement=document.getElementById('streams');
const f=n=>{if(!Number.isFinite(n))return'—';const u=['B','KiB','MiB','GiB','TiB'];let i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return n.toFixed(i?2:0)+' '+u[i]};
async function command(name){await fetch('/api/'+name,{method:'POST'});await update()}
startButton.addEventListener('click',()=>command('start'));
stopButton.addEventListener('click',()=>command('stop'));
async function update(){const s=await fetch('/api/status',{cache:'no-store'}).then(r=>r.json());stateLabel.textContent=s.recording?'● RECORDING':s.stopReason||'stopped';stateLabel.className=s.recording?'good':'';
startButton.disabled=s.recording;stopButton.disabled=!s.recording;const cells=[['Router',s.connected?'connected':'disconnected'],['Session samples',s.sessionSamples.toLocaleString()],['Session size',f(s.sessionBytes)],['Recorded storage',f(s.diskBytes)+' / '+f(s.maxBytes)],['Free disk',f(s.freeBytes)],['Files',s.files+' finalized · '+s.openFiles+' open'],['Started',s.startedAt||'—'],['Last message',s.lastMessageAt||'—'],['Directory',s.dataDirectory],['Error',s.error||'none']];
summaryElement.innerHTML=cells.map(x=>'<div><div class="label">'+x[0]+'</div><div class="value">'+x[1]+'</div></div>').join('');
streamsElement.innerHTML=Object.entries(s.streams).sort().map(([k,v])=>'<tr><td>'+k+'</td><td>'+v.samples.toLocaleString()+'</td><td>'+v.missing.toLocaleString()+'</td><td>'+v.duplicates.toLocaleString()+'</td><td>'+String(v.lastValue??'—')+'</td></tr>').join('')}
update();setInterval(update,1000);
</script>`;

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
      return;
    }
    if (request.method === 'GET' && request.url === '/api/status') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(publicStatus()));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/start') {
      await startRecording();
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(publicStatus()));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/stop') {
      await stopRecording();
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(publicStatus()));
      return;
    }
    response.writeHead(404).end('not found');
  } catch (error) {
    response.writeHead(409, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: error.message }));
  }
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  routerSocket?.close();
  await stopRecording('service stopped');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
scanStorage();
setInterval(scanStorage, 10000).unref();
connectRouter();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Recorder controls: http://127.0.0.1:${PORT}`);
  console.log(`Recordings: ${DATA_DIR}`);
});
