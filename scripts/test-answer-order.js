// The answer comes first and a page link after it; a job's answer gets a
// header only for an outcome that was really not met, named.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { linkLast } = require('../lib/page-link');

test('a page link moves after the answer, once', () => {
  assert.equal(linkLast('[Open the page](/page/abc)\n\n[[next]]\n\nPack light.\n\nTwo washes.\n\n[[next]]\n\nRain due.'),
    'Pack light.\n\nTwo washes.\n\n[[next]]\n\nRain due.\n\n[Open the page](/page/abc)');
  assert.equal(linkLast('Pack light.\n\n[Open the page](/page/abc)'), 'Pack light.\n\n[Open the page](/page/abc)');
  assert.equal(linkLast('Open the page: https://x.example/page/abc\n\nAnswer.'), 'Answer.\n\nOpen the page: https://x.example/page/abc');
  assert.equal(linkLast('Nothing to move.'), 'Nothing to move.');
  const engine = fs.readFileSync(path.join(__dirname, '..', 'lib', 'engine.js'), 'utf8');
  assert.ok(engine.indexOf('require("./page-link").linkLast(finalText)') < engine.indexOf('finalText = require("./follow-on").withBreaks(finalText);'));
});

// A job's answer says itself what it could not do and why (verification.js
// retryNote); a line of Closedhand's own on top ("Not done yet: ...") read as
// if the job were still going when it had stopped.
test("a job's answer goes as it was written, with no line of Closedhand's own on top", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'task-delivery.js'), 'utf8');
  assert.doesNotMatch(src, /Not done yet|partialHeader/);
  assert.match(src, /if \(!report\) return failedNote\(row, store\);\n\s*return reportDigest\(report, dest\.platform/);
});
