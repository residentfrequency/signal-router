'use strict';

const zlib = require('zlib');

const injectedScript = String.raw`
<script>
(() => {
  const mappings = new Map();

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function keyFor(channel, cc) {
    return channel + ':' + cc;
  }

  function ensurePanel() {
    let panel = document.getElementById('resident-beat-range-panel');
    if (panel) return panel;

    panel = document.createElement('section');
    panel.id = 'resident-beat-range-panel';
    panel.className = 'panel global-output-panel';
    panel.style.margin = '12px 0';
    panel.style.padding = '12px';
    panel.style.border = '1px solid rgba(127,127,127,.35)';
    panel.style.borderRadius = '8px';
    panel.style.background = 'rgba(127,127,127,.08)';
    panel.innerHTML = '<div id="resident-global-output-controls"></div>' +
      '<div id="resident-beat-range-rows"></div>';

    const controls = panel.querySelector('#resident-global-output-controls');
    const midiPanel = document.querySelector('.midi-panel');
    const globalBeatPanel = document.querySelector('body > .beat-strip');
    if (midiPanel) {
      midiPanel.classList.remove('panel');
      controls.appendChild(midiPanel);
    }
    if (globalBeatPanel) {
      globalBeatPanel.classList.remove('panel');
      controls.appendChild(globalBeatPanel);
    }

    const mount = document.querySelector('main, #app') || document.body;
    if (mount.firstChild) mount.insertBefore(panel, mount.firstChild);
    else mount.appendChild(panel);
    return panel;
  }

  function ensureRow(channel, cc) {
    const key = keyFor(channel, cc);
    let row = document.querySelector('[data-beat-range-key="' + key + '"]');
    if (row) return mappings.get(key);

    const panel = ensurePanel();
    const rows = panel.querySelector('#resident-beat-range-rows');

    row = document.createElement('div');
    row.dataset.beatRangeKey = key;
    row.style.display = 'grid';
    row.style.gridTemplateColumns = 'minmax(100px,1fr) minmax(180px,2fr) minmax(180px,2fr)';
    row.style.gap = '12px';
    row.style.alignItems = 'center';
    row.style.padding = '7px 0';
    row.style.borderTop = rows.children.length ? '1px solid rgba(127,127,127,.2)' : '0';

    const route = document.createElement('div');
    route.textContent = 'Ch ' + (channel + 1) + ' · CC ' + cc;
    route.style.fontWeight = '600';

    const widthLabel = document.createElement('label');
    widthLabel.style.display = 'grid';
    widthLabel.style.gridTemplateColumns = '52px 1fr 52px';
    widthLabel.style.gap = '8px';
    widthLabel.style.alignItems = 'center';
    const widthText = document.createElement('span');
    widthText.textContent = 'Width';
    const width = document.createElement('input');
    width.type = 'range';
    width.min = '0';
    width.max = '800';
    width.step = '5';
    width.value = '100';
    const widthValue = document.createElement('span');
    widthValue.textContent = '100%';
    widthLabel.append(widthText, width, widthValue);

    const centerLabel = document.createElement('label');
    centerLabel.style.display = 'grid';
    centerLabel.style.gridTemplateColumns = '52px 1fr 32px';
    centerLabel.style.gap = '8px';
    centerLabel.style.alignItems = 'center';
    const centerText = document.createElement('span');
    centerText.textContent = 'Center';
    const center = document.createElement('input');
    center.type = 'range';
    center.min = '0';
    center.max = '127';
    center.step = '1';
    center.value = '64';
    const centerValue = document.createElement('span');
    centerValue.textContent = '64';
    centerLabel.append(centerText, center, centerValue);

    row.append(route, widthLabel, centerLabel);
    rows.appendChild(row);

    const mapping = { amount: 1, center: 64 };
    mappings.set(key, mapping);
    width.addEventListener('input', () => {
      mapping.amount = Number(width.value) / 100;
      widthValue.textContent = width.value + '%';
    });
    center.addEventListener('input', () => {
      mapping.center = Number(center.value);
      centerValue.textContent = center.value;
    });
    return mapping;
  }

  function wrapAccess(access) {
    for (const output of access.outputs.values()) {
      if (output.__residentBeatRangeWrapped) continue;
      const originalSend = output.send.bind(output);
      output.send = (data, timestamp) => {
        const bytes = Array.from(data || []);
        if (bytes.length >= 3 && (bytes[0] & 0xF0) === 0xB0 && bytes[1] !== 123) {
          const channel = bytes[0] & 0x0F;
          const cc = bytes[1];
          const mapping = ensureRow(channel, cc);
          bytes[2] = clamp(Math.round(mapping.center + (bytes[2] - 64) * mapping.amount), 0, 127);
          return originalSend(bytes, timestamp);
        }
        return originalSend(data, timestamp);
      };
      output.__residentBeatRangeWrapped = true;
    }
    access.addEventListener?.('statechange', () => wrapAccess(access));
    return access;
  }

  const availabilityStyle = document.createElement('style');
  availabilityStyle.textContent = [
    '.global-output-panel .midi-panel,.global-output-panel .beat-strip{border:0;margin:0;padding:8px 0;background:transparent}',
    '.global-output-panel .beat-strip{border-top:1px solid rgba(127,127,127,.2)}',
    '.global-output-panel #resident-beat-range-rows:not(:empty){border-top:1px solid rgba(127,127,127,.2);margin-top:6px;padding-top:4px}',
    '.availability-disabled{opacity:.35}',
    '#resident-readiness{margin-top:6px}',
    '.resident-stream-value{display:block;margin-top:3px;font:12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted,#9292a4)}',
    'button:disabled,input:disabled,select:disabled{cursor:not-allowed;opacity:.35}',
    'tr.availability-disabled td{color:inherit}',
  ].join('');
  document.head.appendChild(availabilityStyle);

  const unfilteredActiveVoicesForDevice = activeVoicesForDevice;
  activeVoicesForDevice = name => unfilteredActiveVoicesForDevice(name)
    .filter(voice => messages.get(voice.streamId)?.ready === true);

  const readyActiveVoicesForDevice = activeVoicesForDevice;
  const unfilteredSyncAudio = syncAudio;
  syncAudio = function syncReadyAudio() {
    const previous = activeVoicesForDevice;
    activeVoicesForDevice = name => readyActiveVoicesForDevice(name)
      .filter(voice => streamSettings(voice.streamId).noteEnabled);
    try {
      return unfilteredSyncAudio();
    } finally {
      activeVoicesForDevice = previous;
    }
  };

  function updateOutputAvailability() {
    const allMessages = [...messages.values()];
    const readyCount = allMessages.filter(message => message.ready === true).length;
    const anyReady = readyCount > 0;
    let readiness = document.getElementById('resident-readiness');
    if (!readiness) {
      readiness = document.createElement('div');
      readiness.id = 'resident-readiness';
      readiness.className = 'status';
      const status = document.getElementById('status');
      if (status) status.insertAdjacentElement('afterend', readiness);
      else (document.querySelector('main, #app') || document.body).prepend(readiness);
    }
    readiness.textContent = readyCount + ' of ' + allMessages.length + ' streams ready';
    midiEnable.disabled = !anyReady;
    midiEnable.closest('.midi-panel')?.classList.toggle('availability-disabled', !anyReady);
    globalBeatEnabled.disabled = !anyReady;
    globalBeatChannel.disabled = !anyReady;
    globalBeatCc.disabled = !anyReady;
    globalBeatEnabled.closest('.beat-strip')?.classList.toggle('availability-disabled', !anyReady);

    if (!anyReady && midiEnabled) {
      panicMidi();
      midiEnabled = false;
      midiEnable.textContent = 'enable MIDI';
      midiEnable.classList.remove('enabled');
      updateMidiStatus();
    }

    for (const group of groups.values()) {
      const deviceReady = [...messages.entries()]
        .some(([id, message]) => deviceName(id) === group.name && message.ready === true);
      group.button.disabled = !deviceReady;
      if (!deviceReady && group.enabled) {
        group.enabled = false;
        group.button.textContent = 'start audio';
        group.button.classList.remove('playing');
        syncAudio();
      }
      const deviceBeatControls = group.section.querySelectorAll(
        '.device-beat-enabled,.device-beat-channel,.device-beat-cc',
      );
      deviceBeatControls.forEach(control => { control.disabled = !deviceReady; });
      group.section.querySelector('.beat-strip')
        ?.classList.toggle('availability-disabled', !deviceReady);

      for (const [id, row] of group.rows) {
        const ready = messages.get(id)?.ready === true;
        row.classList.toggle('availability-disabled', !ready);
        row.querySelectorAll('input,select').forEach(control => {
          control.disabled = !ready;
        });
      }
    }
  }

  window.updateResidentValues = function updateResidentValues(updates) {
    for (const update of updates || []) {
      const message = messages.get(update.device);
      if (message) message.value = update.value;
      const group = groups.get(deviceName(update.device));
      const value = group?.rows.get(update.device)?.querySelector('.resident-stream-value');
      const incoming = Number(update.value);
      if (value && Number.isFinite(incoming)) {
        value.textContent = Math.abs(incoming) >= 100
          ? incoming.toFixed(2)
          : incoming.toFixed(4);
      }
    }
  };

  const unfilteredRender = render;
  render = function renderWithAvailability(message) {
    unfilteredRender(message);
    const group = groups.get(deviceName(message.device));
    const row = group?.rows.get(message.device);
    if (row) {
      const cells = row.children;
      const title = cells[0];
      let value = title.querySelector('.resident-stream-value');
      if (!value) {
        value = document.createElement('span');
        value.className = 'resident-stream-value';
        title.appendChild(value);
      }
      const incoming = Number(message.value);
      value.textContent = Number.isFinite(incoming)
        ? (Math.abs(incoming) >= 100 ? incoming.toFixed(2) : incoming.toFixed(4))
        : '—';
      if (cells[6] && !message.ready && message.reason === 'coverage') {
        cells[6].textContent = 'reading';
      }
      if (cells[7]) {
        const coverage = Number(message.coverage);
        cells[7].textContent = Number.isFinite(coverage)
          ? (coverage * 100).toFixed(0) + '%'
          : '—';
      }
    }
    updateOutputAvailability();
  };

  const pairwiseBeatValueFor = beatValueFor;
  beatValueFor = function phaseAwareBeatValue(key, voices, now) {
    if (!voices.length) return '—';
    if (voices.length > 1) return pairwiseBeatValueFor(key, voices, now);

    const voice = voices[0];
    const state = beatState(key);
    const dt = Math.min(0.1, Math.max(0, (now - state.lastTime) / 1000));
    state.lastTime = now;
    const phaseKey = 'single:' + voiceKey(voice.streamId, voice.id);
    let phase = state.phases.get(phaseKey);
    if (!Number.isFinite(phase)) phase = Number.isFinite(voice.phase) ? voice.phase : 0;
    phase = (phase + 2 * Math.PI * Math.max(0, Number(voice.frequencyHz) || 0) * dt)
      % (2 * Math.PI);
    state.phases.clear();
    state.phases.set(phaseKey, phase);
    const raw = Math.cos(phase);
    state.smoothed += 0.12 * (raw - state.smoothed);
    return Math.max(0, Math.min(127, Math.round((state.smoothed + 1) * 63.5)));
  };

  const sendFiniteBeat = maybeSendBeat;
  maybeSendBeat = function maybeSendFiniteBeat(config, value) {
    if (!Number.isFinite(value)) return;
    return sendFiniteBeat(config, value);
  };

  const originalRequestMIDIAccess = navigator.requestMIDIAccess && navigator.requestMIDIAccess.bind(navigator);
  if (originalRequestMIDIAccess) {
    navigator.requestMIDIAccess = (...args) => originalRequestMIDIAccess(...args).then(wrapAccess);
  }

  function initializeResidentControls() {
    ensurePanel();
    updateOutputAvailability();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeResidentControls, { once: true });
  } else {
    initializeResidentControls();
  }
})();
</script>`;

const originalGunzipSync = zlib.gunzipSync;
zlib.gunzipSync = function residentPageGunzip(buffer, options) {
  const result = originalGunzipSync.call(this, buffer, options);
  const isBuffer = Buffer.isBuffer(result);
  const html = isBuffer ? result.toString('utf8') : String(result);

  if (!html.includes('RESIDENT FREQUENCY VOICES') || html.includes('resident-beat-range-panel')) {
    return result;
  }

  const liveValueHtml = html.replace(
    "if(d.type==='resident_voices')render(d)",
    "if(d.type==='resident_voices')render(d);else if(d.type==='resident_values')window.updateResidentValues?.(d.updates)",
  );
  const injected = liveValueHtml.includes('</body>')
    ? liveValueHtml.replace('</body>', injectedScript + '\n</body>')
    : liveValueHtml + injectedScript;

  console.log('Beat CC range controls injected into resident page');
  return isBuffer ? Buffer.from(injected, 'utf8') : injected;
};

const { startResidentLive } = require('./resident-live');
startResidentLive();
