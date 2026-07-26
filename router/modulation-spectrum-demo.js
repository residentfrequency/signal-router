'use strict';

const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.MODULATION_DEMO_PORT || 3003);
const ROUTER_URL = process.env.RESIDENT_ROUTER_URL || 'wss://127.0.0.1:3000';

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Frequency × Modulation Frequency</title>
<style>
  :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #07080b; color: #e8ecf3; }
  main { min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; gap: 12px; padding: 18px; }
  header { display: flex; align-items: end; justify-content: space-between; gap: 16px; }
  h1 { margin: 0; font-size: clamp(18px, 2.4vw, 32px); letter-spacing: .02em; }
  .sub { margin-top: 5px; color: #939cab; font-size: 12px; }
  #status { color: #aab4c3; font-size: 12px; text-align: right; }
  .stage { min-height: 420px; position: relative; border: 1px solid #252a33; background: #030408; overflow: hidden; }
  canvas { width: 100%; height: 100%; display: block; image-rendering: auto; }
  .legend { display: flex; justify-content: space-between; color: #7f8998; font-size: 11px; }
  .steady { color: #f5f7fa; }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>FREQUENCY × MODULATION FREQUENCY</h1>
      <div class="sub">acoustic frequency ↑ · rate of spectral change → · live, non-scrolling</div>
    </div>
    <div id="status">connecting…</div>
  </header>
  <div class="stage"><canvas id="view"></canvas></div>
  <div class="legend"><span class="steady">STEADY / CURRENT</span><span>slow modulation</span><span>fast modulation</span></div>
</main>
<script>
(() => {
  const canvas = document.getElementById('view');
  const ctx = canvas.getContext('2d', { alpha: false });
  const status = document.getElementById('status');
  const acousticBands = 72;
  const modulationBins = 48;
  const historyLength = 128;
  const minHz = 20;
  const maxHz = 8000;
  const maxModHz = 32;
  const decay = 0.93;
  const histories = Array.from({ length: acousticBands }, () => new Float32Array(historyLength));
  const writePositions = new Uint16Array(acousticBands);
  const filled = new Uint16Array(acousticBands);
  const display = Array.from({ length: acousticBands }, () => new Float32Array(modulationBins + 1));
  let frameRate = 30;
  let lastFrameAt = 0;
  let sourceLabel = 'waiting for FFT/spectrum messages';

  function resize() {
    const dpr = Math.max(1, Math.min(2, devicePixelRatio || 1));
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(r.width * dpr));
    canvas.height = Math.max(1, Math.floor(r.height * dpr));
  }
  addEventListener('resize', resize); resize();

  function firstArray(obj, keys) {
    for (const key of keys) if (Array.isArray(obj?.[key]) || ArrayBuffer.isView(obj?.[key])) return Array.from(obj[key]);
    return null;
  }

  function extractSpectrum(message) {
    const candidates = [message, message?.payload, message?.data, message?.spectrum, message?.fft].filter(v => v && typeof v === 'object');
    for (const obj of candidates) {
      const magnitudes = firstArray(obj, ['magnitudes', 'magnitude', 'values', 'bins', 'spectrum', 'fft']);
      if (!magnitudes || magnitudes.length < 8 || !magnitudes.every(Number.isFinite)) continue;
      const frequencies = firstArray(obj, ['frequencies', 'frequencyHz', 'hz']);
      const sampleRate = Number(obj.sampleRate || obj.sample_rate || message.sampleRate || message.sample_rate);
      const fftSize = Number(obj.fftSize || obj.fft_size || message.fftSize || message.fft_size || (magnitudes.length - 1) * 2);
      return { magnitudes, frequencies, sampleRate, fftSize, label: message.device || message.source || message.type || 'router spectrum' };
    }
    return null;
  }

  function magnitudeToLinear(value) {
    return value < 0 ? Math.pow(10, value / 20) : value;
  }

  function ingest(spec) {
    const now = performance.now();
    if (lastFrameAt) {
      const instantaneous = 1000 / Math.max(1, now - lastFrameAt);
      frameRate = frameRate * 0.9 + instantaneous * 0.1;
    }
    lastFrameAt = now;
    sourceLabel = spec.label;
    const nyquist = Number.isFinite(spec.sampleRate) ? spec.sampleRate / 2 : maxHz;

    for (let band = 0; band < acousticBands; band++) {
      const lo = minHz * Math.pow(maxHz / minHz, band / acousticBands);
      const hi = minHz * Math.pow(maxHz / minHz, (band + 1) / acousticBands);
      let sum = 0, count = 0;
      for (let i = 0; i < spec.magnitudes.length; i++) {
        const hz = spec.frequencies?.[i] ?? (i * nyquist / Math.max(1, spec.magnitudes.length - 1));
        if (hz >= lo && hz < hi) { sum += magnitudeToLinear(Number(spec.magnitudes[i])); count++; }
      }
      const value = count ? Math.log1p((sum / count) * 30) : 0;
      const pos = writePositions[band];
      histories[band][pos] = value;
      writePositions[band] = (pos + 1) % historyLength;
      filled[band] = Math.min(historyLength, filled[band] + 1);
      display[band][0] = Math.max(value, display[band][0] * decay);
    }
    computeModulation();
  }

  function computeModulation() {
    const usableMax = Math.min(maxModHz, frameRate / 2);
    for (let band = 0; band < acousticBands; band++) {
      const n = filled[band];
      if (n < 16) continue;
      const h = histories[band];
      const start = (writePositions[band] - n + historyLength) % historyLength;
      let mean = 0;
      for (let j = 0; j < n; j++) mean += h[(start + j) % historyLength];
      mean /= n;
      for (let column = 1; column <= modulationBins; column++) {
        const t = (column - 1) / Math.max(1, modulationBins - 1);
        const modHz = 0.15 * Math.pow(usableMax / 0.15, t);
        let re = 0, im = 0;
        for (let j = 0; j < n; j++) {
          const sample = h[(start + j) % historyLength] - mean;
          const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * j / Math.max(1, n - 1));
          const phase = 2 * Math.PI * modHz * j / frameRate;
          re += sample * window * Math.cos(phase);
          im -= sample * window * Math.sin(phase);
        }
        const power = Math.log1p(Math.hypot(re, im) * 5 / n);
        display[band][column] = Math.max(power, display[band][column] * decay);
      }
    }
  }

  function color(value) {
    const x = Math.max(0, Math.min(1, value * 1.7));
    const r = Math.floor(255 * Math.max(0, Math.min(1, 1.8 * x - 0.45)));
    const g = Math.floor(255 * Math.max(0, Math.min(1, 1.9 - Math.abs(x - 0.55) * 3.2)));
    const b = Math.floor(255 * Math.max(0, Math.min(1, 1.25 - x * 1.15)));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function draw() {
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#030408'; ctx.fillRect(0, 0, w, h);
    const labelW = 62 * (devicePixelRatio || 1);
    const plotW = w - labelW;
    const cw = plotW / (modulationBins + 1);
    const ch = h / acousticBands;
    for (let band = 0; band < acousticBands; band++) {
      const y = h - (band + 1) * ch;
      for (let col = 0; col <= modulationBins; col++) {
        ctx.fillStyle = color(display[band][col]);
        ctx.fillRect(labelW + col * cw, y, Math.ceil(cw + .5), Math.ceil(ch + .5));
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(labelW + cw, 0, 1, h);
    ctx.font = (10 * (devicePixelRatio || 1)) + 'px ui-monospace';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#8a94a3';
    [20, 50, 100, 200, 500, 1000, 2000, 4000, 8000].forEach(hz => {
      const y = h - Math.log(hz / minHz) / Math.log(maxHz / minHz) * h;
      ctx.fillText(hz >= 1000 ? (hz / 1000) + 'k' : hz, labelW - 8, y);
    });
    status.textContent = sourceLabel + ' · ' + frameRate.toFixed(1) + ' spectrum fps';
    requestAnimationFrame(draw);
  }

  function connect() {
    const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    socket.onopen = () => { status.textContent = 'connected · waiting for FFT/spectrum messages'; };
    socket.onmessage = event => {
      try { const spec = extractSpectrum(JSON.parse(event.data)); if (spec) ingest(spec); } catch {}
    };
    socket.onclose = () => { status.textContent = 'disconnected · retrying'; setTimeout(connect, 1500); };
    socket.onerror = () => socket.close();
  }
  connect(); draw();
})();
</script>
</body>
</html>`;

function startDemo() {
  const server = http.createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/modulation-spectrum/') {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
  });

  const browserSockets = new WebSocketServer({ server });
  let routerSocket;
  let reconnectTimer;
  const connectRouter = () => {
    routerSocket = new WebSocket(ROUTER_URL, { rejectUnauthorized: false });
    routerSocket.on('message', raw => {
      for (const client of browserSockets.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(raw.toString());
      }
    });
    routerSocket.on('close', () => { reconnectTimer = setTimeout(connectRouter, 2000); });
    routerSocket.on('error', () => {});
  };
  connectRouter();
  server.listen(PORT, () => console.log(`Modulation spectrum: http://localhost:${PORT}/modulation-spectrum/`));
  return { close() { clearTimeout(reconnectTimer); routerSocket?.close(); browserSockets.close(); server.close(); } };
}

if (require.main === module) startDemo();
module.exports = { startDemo };
