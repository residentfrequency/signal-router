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
