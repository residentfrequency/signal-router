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
*{box-sizing:border-box}body{margin:0;padding:20px;background:#0a0a0a;color:#00ff88;font:14px monospace}h1{font-size:15px;letter-spacing:.2em;opacity:.65}.status{opacity:.5;margin:8px 0 18px}.device-group{margin:0 0 28px;border:1px solid #1b1b1b}.device-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:12px;border-bottom:1px solid #1b1b1b}.device-heading h2{margin:0;font-size:14px;letter-spacing:.16em;text-transform:uppercase}.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.controls button,.controls select,.controls input{font:inherit;background:#111;color:#aaffd4;border:1px solid #28503e;padding:6px}.controls button.playing{background:#143526;color:#fff}.controls label{display:flex;gap:7px;align-items:center}.controls input[type=range]{padding:0;width:115px}.readout{min-width:3ch;color:#fff}.audio-status{opacity:.5;min-width:96px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px;border-bottom:1px solid #1b1b1b;vertical-align:top}tbody tr:last-child td{border-bottom:0}th{font-size:11px;opacity:.4}.device{max-width:34vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.waiting{opacity:.35}.voice{display:block;color:#aaffd4;margin-bottom:3px}.voice.inactive{opacity:.35}.empty{padding:14px;opacity:.35}
</style></head><body><h1>RESIDENT FREQUENCY VOICES</h1><div class="status" id="status">connecting…</div><main id="groups"></main>
<script>
const messages=new Map();const groups=new Map();const status=document.getElementById('status');const groupsRoot=document.getElementById('groups');
let audioContext=null;let limiter=null;const synthVoices=new Map();
function number(value,digits=3){return Number.isFinite(value)?value.toFixed(digits):'—'}
function deviceName(streamId){const parts=String(streamId||'').split('/').filter(Boolean);return parts.find(part=>part==='indoor-sky'||part==='electric-sky')||parts[1]||parts[0]||'other'}
function streamLabel(streamId){const parts=String(streamId||'').split('/').filter(Boolean);return parts[parts.length-1]||streamId}
function voiceKey(streamId,id){return streamId+'::'+id}
function midiNoteName(note){const names=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];const rounded=Math.round(note);return names[((rounded%12)+12)%12]+(Math.floor(rounded/12)-1)}
function ensureAudio(){if(audioContext)return;audioContext=new (window.AudioContext||window.webkitAudioContext)();limiter=audioContext.createDynamicsCompressor();limiter.threshold.value=-8;limiter.knee.value=12;limiter.ratio.value=8;limiter.attack.value=0.003;limiter.release.value=0.25;limiter.connect(audioContext.destination)}
function createGroup(name){const section=document.createElement('section');section.className='device-group';section.innerHTML='<div class="device-heading"><h2></h2><div class="controls"><button type="button">start audio</button><label>pitch mode <select class="pitch-mode"><option value="continuous" selected>continuous</option><option value="midi">MIDI notes</option></select></label><label>base octave <select class="base-octave"><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option></select></label><label>pitch span <input class="span" type="range" min="1" max="6" step="1" value="3"><span class="readout">3</span> oct</label><label>volume <input class="volume" type="range" min="0" max="2.5" step="0.01" value="0.8"><span class="readout volume-value">0.80</span></label><span class="audio-status">audio off</span></div></div><table><thead><tr><th>STREAM</th><th>STATUS</th><th>COVERAGE</th><th>VOICES</th></tr></thead><tbody></tbody></table>';
const heading=section.querySelector('h2');heading.textContent=name;const button=section.querySelector('button');const pitchMode=section.querySelector('.pitch-mode');const baseOctave=section.querySelector('.base-octave');const span=section.querySelector('.span');const spanValue=span.nextElementSibling;const volume=section.querySelector('.volume');const volumeValue=section.querySelector('.volume-value');const audioStatus=section.querySelector('.audio-status');const body=section.querySelector('tbody');
const group={name,section,body,rows:new Map(),enabled:false,bus:null,button,pitchMode,baseOctave,span,spanValue,volume,volumeValue,audioStatus};groups.set(name,group);groupsRoot.appendChild(section);
button.addEventListener('click',async()=>{ensureAudio();if(audioContext.state==='suspended')await audioContext.resume();if(!group.bus){group.bus=audioContext.createGain();group.bus.gain.value=0;group.bus.connect(limiter)}group.enabled=!group.enabled;button.textContent=group.enabled?'stop audio':'start audio';button.classList.toggle('playing',group.enabled);syncAudio()});
pitchMode.addEventListener('change',()=>{renderAll();syncAudio()});baseOctave.addEventListener('change',()=>{renderAll();syncAudio()});span.addEventListener('input',()=>{spanValue.textContent=span.value;renderAll();syncAudio()});volume.addEventListener('input',()=>{volumeValue.textContent=Number(volume.value).toFixed(2);syncAudio()});return group}
function mappedMidiValues(residentHz,group){const minResidentHz=0.05;const maxResidentHz=1;const clamped=Math.max(minResidentHz,Math.min(maxResidentHz,residentHz));const position=Math.log2(clamped/minResidentHz)/Math.log2(maxResidentHz/minResidentHz);const lowMidi=(Number(group.baseOctave.value)+1)*12;const continuousMidi=lowMidi+position*(Number(group.span.value)*12);return{continuousMidi,quantizedMidi:Math.round(continuousMidi)}}
function mappedAudioFrequency(residentHz,group){const midi=mappedMidiValues(residentHz,group);const outputMidi=group.pitchMode.value==='midi'?midi.quantizedMidi:midi.continuousMidi;return 440*Math.pow(2,(outputMidi-69)/12)}
function activeVoicesFor(name){const result=[];for(const [streamId,message] of messages){if(deviceName(streamId)!==name)continue;for(const voice of message.voices||[]){if(voice.active)result.push({streamId,...voice})}}return result}
function createSynthVoice(key,group,initialFrequency){const oscillator=audioContext.createOscillator();const gain=audioContext.createGain();oscillator.type='sine';oscillator.frequency.value=initialFrequency;gain.gain.value=0;oscillator.connect(gain).connect(group.bus);oscillator.start();const synth={oscillator,gain,groupName:group.name};synthVoices.set(key,synth);return synth}
function syncAudio(){if(!audioContext||!limiter)return;const now=audioContext.currentTime;const activeKeys=new Set();for(const group of groups.values()){if(!group.bus){group.bus=audioContext.createGain();group.bus.gain.value=0;group.bus.connect(limiter)}const voices=activeVoicesFor(group.name);const normalization=voices.length?1/Math.pow(voices.length,0.35):1;for(const voice of voices){const key=voiceKey(voice.streamId,voice.id);activeKeys.add(key);const frequency=mappedAudioFrequency(voice.frequencyHz,group);let synth=synthVoices.get(key);if(!synth){synth=createSynthVoice(key,group,frequency)}else{synth.oscillator.frequency.cancelScheduledValues(now);synth.oscillator.frequency.setTargetAtTime(frequency,now,0.18)}const voiceGain=Math.max(0.015,Math.min(0.22,0.18*voice.confidence))*normalization;synth.gain.gain.cancelScheduledValues(now);synth.gain.gain.setTargetAtTime(group.enabled?voiceGain:0,now,0.35)}group.bus.gain.cancelScheduledValues(now);group.bus.gain.setTargetAtTime(group.enabled?Number(group.volume.value):0,now,0.12);group.audioStatus.textContent=group.enabled?(voices.length+' active voice'+(voices.length===1?'':'s')):'audio off'}for(const [key,synth] of synthVoices){if(activeKeys.has(key))continue;synth.gain.gain.cancelScheduledValues(now);synth.gain.gain.setTargetAtTime(0,now,0.6);setTimeout(()=>{if(!activeKeys.has(key)&&synthVoices.get(key)===synth){try{synth.oscillator.stop()}catch{}synth.oscillator.disconnect();synth.gain.disconnect();synthVoices.delete(key)}},2500)}}
function renderVoice(v,group){const midi=mappedMidiValues(v.frequencyHz,group);return '<span class="voice '+(v.active?'':'inactive')+'">#'+v.id+' '+number(v.frequencyHz,4)+' Hz · '+number(v.periodSeconds,2)+' s · MIDI '+number(midi.continuousMidi,2)+' → '+midi.quantizedMidi+' ('+midiNoteName(midi.quantizedMidi)+') · conf '+number(v.confidence,2)+'</span>'}
function render(message){messages.set(message.device,message);const name=deviceName(message.device);const group=groups.get(name)||createGroup(name);let row=group.rows.get(message.device);if(!row){row=document.createElement('tr');row.innerHTML='<td class="device"></td><td></td><td></td><td></td>';group.body.appendChild(row);group.rows.set(message.device,row)}const cells=row.children;cells[0].textContent=streamLabel(message.device);cells[0].title=message.device;cells[1].textContent=message.ready?'ready':(message.reason||'waiting');cells[1].className=message.ready?'':'waiting';cells[2].textContent=number(message.coverage,2);const all=[...(message.voices||[])].sort((a,b)=>a.id-b.id);const active=all.filter(v=>v.active);const shown=active.length?active:all.slice(0,3);cells[3].innerHTML=shown.length?shown.map(v=>renderVoice(v,group)).join(''):'<span class="waiting">none</span>';syncAudio()}
function renderAll(){for(const message of messages.values())render(message)}
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
