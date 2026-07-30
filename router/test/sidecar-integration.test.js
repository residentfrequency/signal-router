'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { page: modulationSpectrumPage } = require('../modulation-spectrum-demo-v3');

test('modulation spectrum page uses the serving HTTPS origin and PCM subscription', () => {
  const html = modulationSpectrumPage();
  assert.match(html, /location\.protocol==='https:'\?'wss:\/\/':'ws:\/\/'/);
  assert.match(html, /type:'pcm_subscribe'/);
  assert.match(html, /pcm\/indoor-sky\/audio/);
});

test('resident sidecar stays local and skips analysis without browser clients', () => {
  const source = fs.readFileSync(path.join(__dirname, '../resident-live.js'), 'utf8');
  assert.match(source, /if \(wss\.clients\.size === 0\) return;/);
  assert.match(source, /server\.listen\(port, '127\.0\.0\.1'/);
});

test('main HTTPS server exposes and subscribes both analysis pages', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /app\.get\('\/resident\/'/);
  assert.match(source, /type:'resident_subscribe',enabled:true/);
  assert.match(source, /new WebSocket\(`ws:\/\/127\.0\.0\.1:\$\{RESIDENT_PORT\}`\)/);
  assert.match(source, /app\.get\('\/modulation-spectrum\/'/);
});
