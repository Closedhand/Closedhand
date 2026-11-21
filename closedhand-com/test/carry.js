// The home page's conversation, carried into Closedhand: kept in the
// visitor's browser (public/ask.js) and handed back by /carry (public/carry.js)
// to the computer the browser is on, once. No database needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// The conversation is kept in the visitor's browser and carried into
// Closedhand once it is set up: /carry hands it back to the computer this
// browser is on, after "#", and forgets it here.
test('the home page conversation is kept in this browser, and /carry hands it only to this computer, once', () => {
  const vm = require('node:vm');
  const carry = fs.readFileSync(path.join(__dirname, '..', 'public', 'carry.js'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'ask.js'), 'utf8');
  const state = 'a'.repeat(32);
  const turns = [{ role: 'user', text: 'Is it safe to eat raw cookie dough?' }, { role: 'assistant', text: 'Mostly, if the flour is heat-treated.' }];
  const run = (hash, saved) => {
    const store = new Map(saved ? [['ch-ask', JSON.stringify(saved)]] : []);
    const went = [], line = { textContent: '' };
    vm.runInNewContext(carry, {
      URL, URLSearchParams, JSON, Date,
      location: { hash, replace: (to) => went.push(to) },
      localStorage: { getItem: (k) => store.has(k) ? store.get(k) : null, removeItem: (k) => store.delete(k) },
      document: { getElementById: () => line },
    });
    return { went, left: store.has('ch-ask'), line: line.textContent };
  };
  const back = (b) => '#' + new URLSearchParams({ back: b, state });

  const home = run(back('http://localhost:3000/'), { at: Date.now(), turns });
  assert.equal(home.went.length, 1);
  const to = new URL(home.went[0]);
  assert.equal(to.origin + to.pathname, 'http://localhost:3000/');
  const p = new URLSearchParams(to.hash.slice(1));
  assert.equal(p.get('state'), state);
  assert.deepEqual(JSON.parse(p.get('carry')), turns);
  assert.equal(home.left, false, 'forgotten here once handed back');

  for (const elsewhere of ['https://evil.example/', 'http://evil.example/', 'http://localhost:3000/setup', 'http://user:pw@localhost:3000/', 'javascript:alert(1)']) {
    const r = run(back(elsewhere), { at: Date.now(), turns });
    assert.deepEqual(r.went, [], 'never to ' + elsewhere);
    assert.equal(r.left, true, 'and kept for this computer');
  }
  assert.deepEqual(run('#' + new URLSearchParams({ back: 'http://127.0.0.1:3000/', state: 'short' }), { at: Date.now(), turns }).went, [], 'only with a one-time value');
  const old = run(back('http://127.0.0.1:3000/'), { at: Date.now() - 8 * 24 * 3600 * 1000, turns });
  assert.equal(new URLSearchParams(new URL(old.went[0]).hash.slice(1)).get('carry'), null, 'past 7 days, nothing goes');
  const none = run(back('http://[::1]:3000/'), null);
  assert.equal(new URLSearchParams(new URL(none.went[0]).hash.slice(1)).get('state'), state, 'nothing kept: back with only the value');

  // The box keeps it for 7 days, shows it again, and says it will be waiting.
  assert.match(script, /var KEY = 'ch-ask', KEPT = 7 \* 24 \* 3600 \* 1000;/);
  assert.match(script, /state\.told = true;\n      keep\(\);\n      after\(\);/);
  assert.match(script, /this conversation will be waiting in the web chat/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /app\.get\('\/carry', page\('carry\.html'\)\);/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'views', 'privacy.html'), 'utf8'), /Your browser keeps the conversation for 7 days/);
});

test('three questions a visitor a day unless set otherwise', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'ask.js'), 'utf8'), /Number\(env\.ASK_PER_VISITOR_DAY \|\| 3\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'ask.js'), 'utf8'), /var state = \{ key: null, left: null, of: 3,/);
});
