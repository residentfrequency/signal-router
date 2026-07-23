const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('visualizer starts its animation loop', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../visualizer/index.html'), 'utf8');
  const calls = html.match(/requestAnimationFrame\(render\)/g) || [];
  assert.equal(calls.length, 2, 'render must schedule its successor and receive one initial frame');
  assert.match(html, /}\s*requestAnimationFrame\(render\);\s*<\/script>/);
});

test('PCM and scalar waveforms share gain and the Web Audio analyser', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../visualizer/index.html'), 'utf8');
  assert.match(html, /visualGain=gainAmount\(\)/);
  assert.match(html, /audioOn&&waveformAnalyser&&windowSeconds\*audioCtx\.sampleRate<=32768\?drawPlaybackWaveform\(\):drawSeries\(windowSeconds\)/);
  assert.doesNotMatch(html, /isPcm&&audioOn&&waveformAnalyser/);
  assert.match(html, /normalizationNode=audioCtx\.createGain\(\)/);
});

test('spectral views start progressively and spectrogram cursor uses both axes', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../visualizer/index.html'), 'utf8');
  assert.match(html, /ring\.sampleCount<32/);
  assert.match(html, /while\(n\*2<=selected&&n\*2<=ring\.sampleCount\)n\*=2/);
  assert.match(html, /position=view==='spectrogram'\?1-ny:nx/);
  assert.match(html, /rect\.width-x\)\/30/);
});

test('filtered spectrogram uses a fixed background-relative color scale', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../visualizer/index.html'), 'utf8');
  assert.match(html, /if\(spectralMode==='filtered'\)return Math\.max\(0,Math\.min\(1,\(Math\.log2/);
  assert.match(html, /color 0\.5× · 1× · 2× · 4× · 8×\+/);
  assert.match(html, /v=spectrogramLevel\(value,peak\)\*255/);
});

test('controls follow the active visualization', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../visualizer/index.html'), 'utf8');
  assert.match(html, /\[hidden\]\{display:none!important\}/);
  assert.match(html, /class="controls global-controls"/);
  assert.match(html, /class="controls view-controls"/);
  assert.match(html, /class="wave-control">window/);
  assert.match(html, /class="spectral-control">FFT/);
  assert.match(html, /class="spectrogram-control"><input id="smooth"/);
  assert.match(html, /function updateControlVisibility\(\)/);
  assert.doesNotMatch(html, /id="fps"/);
});

test('spectrum cursor reports chart coordinates on both axes', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../visualizer/index.html'), 'utf8');
  assert.match(html, /\$\{hz\.toFixed\(3\)\} Hz · \$\{\(-80\*ny\)\.toFixed\(1\)\} dB/);
  assert.match(html, /const ratio=2\*\*\(3-4\*ny\)/);
});
