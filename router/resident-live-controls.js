'use strict';

const { startResidentLive } = require('./resident-live');

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
    panel.style.margin = '12px 0';
    panel.style.padding = '12px';
    panel.style.border = '1px solid rgba(127,127,127,.35)';
    panel.style.borderRadius = '8px';
    panel.style.background = 'rgba(127,127,127,.08)';
    panel.innerHTML = '<div style="font-weight:700;margin-bottom:4px">BEAT CC RANGE</div>' +
      '<div style="font-size:12px;opacity:.75;margin-bottom:10px">Width expands or compresses beat motion; center moves its midpoint.</div>' +
      '<div id="resident-beat-range-rows"><div style="font-size:12px;opacity:.65">Enable MIDI and send a beat CC to create a route row.</div></div>';

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
    if (rows.children.length === 1 && !rows.firstElementChild.dataset.beatRangeKey) rows.textContent = '';

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

  const originalRequestMIDIAccess = navigator.requestMIDIAccess && navigator.requestMIDIAccess.bind(navigator);
  if (originalRequestMIDIAccess) {
    navigator.requestMIDIAccess = (...args) => originalRequestMIDIAccess(...args).then(wrapAccess);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensurePanel, { once: true });
  else ensurePanel();
})();
</script>`;

const instance = startResidentLive();

instance.server.prependListener('request', (req, res) => {
  const originalEnd = res.end.bind(res);
  res.end = (chunk, encoding, callback) => {
    const contentType = String(res.getHeader('content-type') || '');
    if (contentType.includes('text/html') && chunk != null) {
      let html = Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8') : String(chunk);
      if (!html.includes('resident-beat-range-panel')) {
        if (html.includes('</body>')) html = html.replace('</body>', injectedScript + '\n</body>');
        else html += injectedScript;
        chunk = html;
        res.removeHeader('content-length');
      }
    }
    return originalEnd(chunk, encoding, callback);
  };
});
