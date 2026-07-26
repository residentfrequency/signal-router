'use strict';

const http = require('http');
const { startResidentLive } = require('./resident-live');

const originalEnd = http.ServerResponse.prototype.end;

const injectedScript = String.raw`
<script>
(() => {
  const beatMappings = new Map();
  const seen = new WeakSet();

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function findSelects(container) {
    const selects = [...container.querySelectorAll('select')];
    let channel = null;
    let cc = null;
    for (const select of selects) {
      const values = [...select.options].map(option => Number(option.value)).filter(Number.isFinite);
      if (!values.length) continue;
      const max = Math.max(...values);
      if (!channel && max <= 16) channel = select;
      else if (!cc && max > 16) cc = select;
    }
    return { channel, cc };
  }

  function mappingKey(channelSelect, ccSelect) {
    if (!channelSelect || !ccSelect) return null;
    const rawChannel = Number(channelSelect.value);
    const channel = rawChannel > 0 ? rawChannel - 1 : rawChannel;
    return channel + ':' + Number(ccSelect.value);
  }

  function installControls(container) {
    if (seen.has(container)) return;
    const text = (container.textContent || '').toLowerCase();
    if (!text.includes('beat')) return;

    const { channel, cc } = findSelects(container);
    if (!channel || !cc) return;
    seen.add(container);

    const controls = document.createElement('span');
    controls.className = 'beat-range-controls';
    controls.style.display = 'inline-flex';
    controls.style.flexWrap = 'wrap';
    controls.style.gap = '8px';
    controls.style.alignItems = 'center';
    controls.style.marginLeft = '8px';

    const amountLabel = document.createElement('label');
    amountLabel.textContent = 'width ';
    const amount = document.createElement('input');
    amount.type = 'range';
    amount.min = '0';
    amount.max = '800';
    amount.step = '5';
    amount.value = '100';
    amount.style.width = '110px';
    const amountValue = document.createElement('span');
    amountValue.textContent = '100%';
    amountValue.style.minWidth = '4ch';
    amountLabel.append(amount, amountValue);

    const centerLabel = document.createElement('label');
    centerLabel.textContent = 'center ';
    const center = document.createElement('input');
    center.type = 'range';
    center.min = '0';
    center.max = '127';
    center.step = '1';
    center.value = '64';
    center.style.width = '110px';
    const centerValue = document.createElement('span');
    centerValue.textContent = '64';
    centerValue.style.minWidth = '3ch';
    centerLabel.append(center, centerValue);

    controls.append(amountLabel, centerLabel);
    container.appendChild(controls);

    function sync() {
      amountValue.textContent = amount.value + '%';
      centerValue.textContent = center.value;
      for (const [key, value] of beatMappings) {
        if (value.container === container) beatMappings.delete(key);
      }
      const key = mappingKey(channel, cc);
      if (key) beatMappings.set(key, {
        container,
        amount: Number(amount.value) / 100,
        center: Number(center.value),
      });
    }

    amount.addEventListener('input', sync);
    center.addEventListener('input', sync);
    channel.addEventListener('change', sync);
    cc.addEventListener('change', sync);
    sync();
  }

  function scan() {
    const candidates = [...document.querySelectorAll('tr, .beat-row, .beat-control, .controls, label, section, div')];
    for (const candidate of candidates) {
      const text = (candidate.textContent || '').toLowerCase();
      if (!text.includes('beat')) continue;
      const { channel, cc } = findSelects(candidate);
      if (channel && cc) installControls(candidate);
    }
  }

  const originalRequestMIDIAccess = navigator.requestMIDIAccess && navigator.requestMIDIAccess.bind(navigator);
  if (originalRequestMIDIAccess) {
    navigator.requestMIDIAccess = async (...args) => {
      const access = await originalRequestMIDIAccess(...args);
      for (const output of access.outputs.values()) {
        if (output.__residentBeatRangeWrapped) continue;
        const originalSend = output.send.bind(output);
        output.send = (data, timestamp) => {
          const bytes = Array.from(data || []);
          if (bytes.length >= 3 && (bytes[0] & 0xF0) === 0xB0) {
            const channel = bytes[0] & 0x0F;
            const controller = bytes[1];
            const key = channel + ':' + controller;
            const mapping = beatMappings.get(key);
            if (mapping && controller !== 123) {
              const raw = bytes[2];
              const remapped = Math.round(mapping.center + (raw - 64) * mapping.amount);
              bytes[2] = clamp(remapped, 0, 127);
              return originalSend(bytes, timestamp);
            }
          }
          return originalSend(data, timestamp);
        };
        output.__residentBeatRangeWrapped = true;
      }
      return access;
    };
  }

  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
</script>`;

http.ServerResponse.prototype.end = function patchedEnd(chunk, encoding, callback) {
  const contentType = String(this.getHeader('content-type') || '');
  if (contentType.includes('text/html') && chunk != null) {
    let html = Buffer.isBuffer(chunk) ? chunk.toString(encoding || 'utf8') : String(chunk);
    if (html.includes('</body>') && !html.includes('beat-range-controls')) {
      html = html.replace('</body>', injectedScript + '\n</body>');
      chunk = html;
      this.removeHeader('content-length');
    }
  }
  return originalEnd.call(this, chunk, encoding, callback);
};

startResidentLive();
