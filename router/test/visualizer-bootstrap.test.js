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
