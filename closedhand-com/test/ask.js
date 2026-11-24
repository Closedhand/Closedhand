// The home page's question box (lib/ask.js, public/ask.js, public/ask-private.js)
// against a real Postgres, in a database of its own. The provider is a
// stand-in, and so is the sealed hardware: it really opens what the page
// encrypts and seals its answer to the page's key. Nothing leaves this machine.
// Run: DATABASE_URL=postgres://... node --test closedhand-com/test/ask.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString('base64');
const { migrate } = require('../lib/db');
const near = require('../lib/near-private');
const page = require('../public/ask-private.js');
const asking = require('../lib/ask');
const includedAi = require('../lib/included-ai');
const { nearAi, SIGN_IN, BROWSER } = require('./near-ai');

const NAME = 'closedhand_ask_test';
let admin, db;
before(async () => {
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin.query(`CREATE DATABASE ${NAME}`);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + NAME;
  db = new Pool({ connectionString: url.toString() });
  await migrate(db);
});
after(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin?.end();
});

// Five questions a visitor here, set outright: these tests are of how the box
// works, not of its default (three, test/carry.js).
const ENV = { TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY, NEAR_REFRESH_TOKEN: SIGN_IN, NEAR_USER_AGENT: BROWSER, ASK_PER_VISITOR_DAY: '5' };
// The sealed hardware: a key of its own, everything it was sent, and what it
// does next (answer, fail, or have a newer key).
function hardware() {
  const keys = near.clientKeys();
  const h = { keys, got: [], warmed: 0, mode: null, refusals: 0, calls: 0, stopped: [], starts: null, midway: null };
  h.near = {
    seal: near.seal,
    warm: async () => {
      h.warmed++;
      if (h.refusals-- > 0) throw Object.assign(new Error('the proof request returned HTTP 401'), { status: 401 });
      return keys.publicHex;
    },
    // Answers as it writes: a first empty piece, then the words in three
    // pieces, each encrypted on its own. h.starts says how long each call
    // waits before its first piece.
    relay: async (conn, body, sealed, { signal, onChunk } = {}) => {
      const call = h.calls++, wait = (h.starts || [])[call] || 0;
      if (wait) await new Promise((resolve, reject) => { const t = setTimeout(resolve, wait); signal?.addEventListener('abort', () => { clearTimeout(t); h.stopped.push(call); reject(signal.reason); }, { once: true }); });
      if (h.mode === 'down') throw Object.assign(new Error('NEAR AI could not prove its enclave'), { code: 'near_unproven' });
      if (sealed.modelKey !== keys.publicHex) throw Object.assign(new Error('another key'), { status: 409, code: 'near_other_key', key: keys.publicHex });
      if (h.mode === 'refused') return { ok: false, status: 402, json: async () => ({ error: 'spent' }) };
      assert.equal(body.stream, undefined, 'near-private asks for the stream itself');
      h.got.push({ call, conn, body, sealed, opened: body.messages.map(m => ({ role: m.role, text: near.open(m.content, keys.x25519Secret) })) });
      const said = 'Answer to: ' + h.got.at(-1).opened.at(-1).text + (h.starts ? ' (copy ' + (call + 1) + ')' : '');
      const piece = content => onChunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { content } }] });
      piece('');
      const third = Math.ceil(said.length / 3);
      for (const [i, part] of [said.slice(0, third), said.slice(third, 2 * third), said.slice(2 * third)].entries()) {
        if (i === 1 && h.mode === 'unsigned') throw Object.assign(new Error('NEAR AI\'s reply could not be verified'), { code: 'near_unsigned' });
        if (i === 1 && h.midway) await h.midway();
        if (signal?.aborted) throw signal.reason;
        piece(near.seal(part, Buffer.from(sealed.clientKey, 'hex')));
      }
      onChunk({ id: 'chatcmpl-1', choices: [], usage: { completion_tokens: 3 } });
      return { ok: true, status: 200, json: async () => ({ id: 'chatcmpl-1' }) };
    },
  };
  return h;
}
async function setup({ env = {}, clock } = {}) {
  // A fresh stand-in provider each time, so the sign-in kept for the last one goes too.
  await db.query('TRUNCATE site_asks, site_ask_key, near_session');
  const provider = nearAi(), h = hardware();
  const ai = includedAi.create({ db, env: { ...ENV, ...env }, request: provider.request });
  const ask = asking.create({ db, env: { ...ENV, ...env }, includedAi: ai, near: h.near, newKeyWait: 1, secondAfter: 40, ...(clock ? { now: clock } : {}) });
  return { ask, ai, provider, h };
}
// What the page does with a conversation: every turn encrypted to the key
// closedhand.com gave it, and a key of its own for the answer.
// Asks, and reads the pieces of the answer as the page would.
async function answer(ask, sent, ip, signal) {
  const pieces = [];
  const out = await ask.ask(sent.body, ip, piece => pieces.push(piece), signal);
  let text = '';
  for (const piece of pieces) text += await page.open(piece, sent.mine.secret);
  return { ...out, pieces, text };
}
async function fromPage(key, turns) {
  const mine = page.keys();
  const messages = [];
  for (const [i, text] of turns.entries()) messages.push({ role: i % 2 ? 'assistant' : 'user', content: await page.seal(text, key) });
  return { mine, body: { key, client: mine.publicHex, messages } };
}
const today = async () => (await db.query('SELECT asks, askers, capped, went FROM site_asks')).rows[0] || { asks: 0, askers: 0, capped: 0, went: 0 };

test("the page's encryption is the one every Closedhand uses: each part matches Node's, and a field opens only for its key", async () => {
  for (let n = 0; n < 12; n++) {
    const key = crypto.randomBytes(32), nonce = crypto.randomBytes(24), plain = crypto.randomBytes(n * 41);
    assert.deepEqual(Buffer.from(page.xchachaSeal(key, nonce, plain)), near.xchachaSeal(key, nonce, plain), 'XChaCha20-Poly1305');
    assert.deepEqual(Buffer.from(page.xchachaOpen(key, nonce, near.xchachaSeal(key, nonce, plain))), plain);
    assert.deepEqual(Buffer.from(page.hchacha20(key, nonce.subarray(0, 16))), near.hchacha20(key, nonce.subarray(0, 16)), 'HChaCha20');
    const a = crypto.generateKeyPairSync('x25519'), b = crypto.generateKeyPairSync('x25519');
    const secret = Buffer.from(a.privateKey.export({ format: 'jwk' }).d, 'base64url'), other = Buffer.from(b.publicKey.export({ format: 'jwk' }).x, 'base64url');
    assert.deepEqual(Buffer.from(page.x25519(secret, other)), crypto.diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey }), 'X25519');
    const ed = Buffer.from(near.clientKeys().publicHex, 'hex');
    assert.deepEqual(Buffer.from(page.edToX25519(ed)), near.edToX25519(ed), 'an Ed25519 key to its X25519 one');
  }
  const tampered = near.xchachaSeal(Buffer.alloc(32, 1), Buffer.alloc(24, 2), Buffer.from('as sent'));
  tampered[0] ^= 1;
  assert.throws(() => page.xchachaOpen(Buffer.alloc(32, 1), Buffer.alloc(24, 2), tampered), /not what was sent/);

  // The page seals, the sealed hardware opens; the hardware seals, the page opens.
  const enclave = near.clientKeys();
  const question = 'What did the council decide about Harbour Row? Café, naïve, 東京.';
  assert.equal(near.open(await page.seal(question, enclave.publicHex), enclave.x25519Secret), question);
  const mine = page.keys();
  assert.match(mine.publicHex, /^[0-9a-f]{64}$/);
  const answer = near.seal('Only the page that asked reads this.', Buffer.from(mine.publicHex, 'hex'));
  assert.equal(await page.open(answer, mine.secret), 'Only the page that asked reads this.');
  await assert.rejects(page.open(answer, page.keys().secret), /not what was sent/);
});

test('a question goes to the sealed hardware encrypted, with closedhand.com\'s instruction beside it, and its answer comes back for the page alone', async () => {
  const { ask, h } = await setup();
  const key = await ask.key();
  assert.equal(key, h.keys.publicHex, 'the page is given the proven key');
  const question = 'Is the Fixture Street bridge safe to cross?';
  const asked = await fromPage(key, [question]), { mine } = asked;
  const out = await answer(ask, asked, '203.0.113.7');
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { left: 4 });
  assert.equal(out.pieces.length, 3, 'as it is written, the empty first piece left out');
  assert.ok(out.pieces.every(p => /^[0-9a-f]+$/.test(p)), 'closedhand.com hands on ciphertext');
  assert.equal(out.text, 'Answer to: ' + question, 'which the page\'s own code opens, piece by piece');

  const sent = h.got[0];
  assert.doesNotMatch(JSON.stringify(sent.body), /Fixture Street|uncensored LLM/, 'nothing readable in what closedhand.com carried');
  assert.deepEqual(sent.opened.map(m => m.role), ['system', 'user']);
  assert.equal(sent.opened[0].text, asking.INSTRUCTION, 'its own instruction, encrypted to the same key');
  assert.equal(sent.opened[1].text, question);
  assert.equal(sent.body.max_tokens, asking.MAX_TOKENS);
  assert.deepEqual(sent.body.chat_template_kwargs, { enable_thinking: false }, 'the first question answers at once');
  assert.equal(sent.body.model, 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated');
  assert.deepEqual(sent.sealed, { modelKey: key, clientKey: mine.publicHex }, 'the answer is for the page\'s key, never one of closedhand.com\'s');
  assert.match(sent.conn.apiKey, /^sk-/, 'with closedhand.com\'s own key at the provider');

  // A follow-up carries the conversation so far, each turn encrypted afresh.
  const next = await fromPage(key, [question, 'Answer to: ' + question, 'And at night?']);
  assert.equal((await ask.ask(next.body, '203.0.113.7')).status, 200);
  assert.deepEqual(h.got[1].opened.map(m => m.role), ['system', 'user', 'assistant', 'user']);
  assert.deepEqual(h.got[1].body.chat_template_kwargs, { enable_thinking: true }, 'a follow-up thinks first: answered at once, it gave way to a misreading');
  assert.equal(h.got[1].body.max_tokens, asking.MAX_TOKENS + asking.THINKING_TOKENS, 'with room to think on top of the answer');
  assert.deepEqual(await today(), { asks: 2, askers: 1, capped: 0, went: 0 }, 'only the day\'s totals are kept');
  const kept = JSON.stringify((await db.query('SELECT * FROM site_asks')).rows);
  assert.doesNotMatch(kept, /203\.0\.113|Fixture/, 'no address and no words');
});

test('a visitor has a few questions a day; others still have theirs, and the day has a total for everyone', async () => {
  let at = Date.parse('2026-03-03T10:00:00Z');
  const { ask, h } = await setup({ env: { ASK_PER_VISITOR_DAY: '2', ASK_PER_DAY: '3' }, clock: () => at });
  const key = await ask.key();
  const one = async ip => ask.ask((await fromPage(key, ['A question from a fixture'])).body, ip);
  assert.equal((await one('203.0.113.1')).body.left, 1);
  assert.equal((await one('203.0.113.1')).body.left, 0);
  const third = await one('203.0.113.1');
  assert.deepEqual([third.status, third.body.error, third.body.left], [429, 'limit', 0]);
  assert.equal(h.got.length, 2, 'the third never went');
  assert.equal(ask.left('203.0.113.1'), 0);
  assert.equal(ask.left('203.0.113.2'), 2, 'someone else has their own');
  assert.equal((await one('203.0.113.2')).status, 200);
  const full = await one('203.0.113.2');
  assert.deepEqual([full.status, full.body.error], [503, 'busy'], 'the day\'s total for everyone is reached');
  assert.equal(h.got.length, 3);
  assert.deepEqual(await today(), { asks: 3, askers: 2, capped: 1, went: 0 });

  // The next day both start again.
  at += 24 * 3600 * 1000;
  assert.equal(ask.left('203.0.113.1'), 2);
  assert.equal((await one('203.0.113.1')).status, 200);
});

test('a request that is not a short encrypted conversation is turned away before anything is sent', async () => {
  const { ask, h } = await setup();
  const key = await ask.key(), good = (await fromPage(key, ['A question'])).body;
  const bad = [
    { ...good, messages: [{ role: 'user', content: 'in plain words' }] },
    { ...good, messages: [{ role: 'system', content: good.messages[0].content }] },
    { ...good, messages: [...good.messages, { role: 'user', content: good.messages[0].content }] },
    { ...good, messages: [{ role: 'user', content: 'ab'.repeat(5000) }] },
    { ...good, messages: Array.from({ length: 11 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: good.messages[0].content })) },
    { ...good, messages: [] },
    { ...good, key: 'not a key' },
    { ...good, client: undefined },
    { ...good, messages: [{ ...good.messages[0], tool_calls: [] }, { role: 'assistant', content: good.messages[0].content }] },
    null,
  ];
  for (const body of bad) assert.equal((await ask.ask(body, '203.0.113.9')).status, 400);
  assert.equal(h.got.length, 0);
  assert.equal(ask.left('203.0.113.9'), 5, 'and costs the visitor nothing');
  // Only the role and the encrypted words of each turn are passed on.
  await ask.ask({ ...good, messages: [{ ...good.messages[0], name: 'x', tool_calls: [{ id: 'y' }] }], tools: [{}], model: 'another', max_tokens: 99999 }, '203.0.113.9');
  assert.deepEqual(Object.keys(h.got[0].body).sort(), ['chat_template_kwargs', 'max_tokens', 'messages', 'model']);
  assert.deepEqual(Object.keys(h.got[0].body.messages[1]), ['role', 'content']);
  assert.equal(h.got[0].body.max_tokens, asking.MAX_TOKENS);
});

test('a question that could not be answered is not counted: a new key at the sealed hardware, a failed proof, a provider that refuses', async () => {
  const { ask, ai, provider, h } = await setup();
  const key = await ask.key();
  const stale = await fromPage(near.clientKeys().publicHex, ['Encrypted to a key since replaced']);
  const other = await ask.ask(stale.body, '203.0.113.3');
  assert.deepEqual([other.status, other.body.key], [409, h.keys.publicHex], 'the page is given the proven key to encrypt to again');
  h.mode = 'down';
  const down = await ask.ask((await fromPage(key, ['While it is down'])).body, '203.0.113.3');
  assert.deepEqual([down.status, down.body.error], [503, 'busy']);
  h.mode = 'refused';
  const before = [...provider.keys.keys()];
  assert.equal((await ask.ask((await fromPage(key, ['While its key is spent'])).body, '203.0.113.3')).status, 503);
  assert.equal(ask.left('203.0.113.3'), 5);
  assert.deepEqual(await today(), { asks: 0, askers: 0, capped: 0, went: 0 });
  // A key the provider turned down is looked at afresh: nearly spent, it is replaced.
  provider.keys.get(before[0]).usage = 19.5;
  h.mode = null;
  assert.equal((await ask.ask((await fromPage(key, ['After'])).body, '203.0.113.3')).status, 200);
  assert.deepEqual([...provider.keys.values()].map(k => k.name), ['Closedhand questions']);
  assert.notEqual([...provider.keys.keys()][0], before[0], 'a new key, the spent one deleted');
  assert.ok(ai);
});

test('an answer the sealed hardware does not sign for, or that stops part way, is taken back and not counted; someone who leaves part way has asked', async () => {
  const { ask, h } = await setup();
  const key = await ask.key();
  h.mode = 'unsigned';
  const unsigned = await answer(ask, await fromPage(key, ['Signed for only when whole']), '203.0.113.9');
  assert.deepEqual([unsigned.status, unsigned.body.error, unsigned.pieces.length], [503, 'busy', 1], 'a piece had gone: the page takes it back');
  assert.equal(ask.left('203.0.113.9'), 5);
  assert.deepEqual(await today(), { asks: 0, askers: 0, capped: 0, went: 0 });
  h.mode = null;
  const gone = new AbortController();
  h.midway = async () => gone.abort(new Error('the visitor left'));
  const left = await answer(ask, await fromPage(key, ['Read half of']), '203.0.113.9', gone.signal);
  assert.deepEqual([left.status, left.pieces.length], [499, 1]);
  assert.equal(ask.left('203.0.113.9'), 4, 'or closing the page early would make every question free');
  assert.deepEqual(await today(), { asks: 1, askers: 1, capped: 0, went: 0 });
});

test('a question with no word after a few seconds is asked again beside the first: whichever starts first is the answer, and the other is stopped', async () => {
  const { ask, h } = await setup();
  const key = await ask.key();
  // The first copy is slow to start: the second answers, and the first is stopped.
  h.starts = [400, 0];
  const second = await answer(ask, await fromPage(key, ['Slow to start']), '203.0.113.10');
  assert.equal(second.text, 'Answer to: Slow to start (copy 2)');
  assert.deepEqual(h.stopped, [0], 'the copy that never started is stopped');
  // The first starts just as the second goes out: the first is the answer, alone.
  h.calls = 0; h.stopped = []; h.starts = [60, 400];
  const first = await answer(ask, await fromPage(key, ['Started in time']), '203.0.113.10');
  assert.equal(first.text, 'Answer to: Started in time (copy 1)', 'never two answers mixed');
  assert.deepEqual(h.stopped, [1]);
  // A quick answer is asked once.
  h.calls = 0; h.stopped = []; h.starts = [0];
  assert.equal((await answer(ask, await fromPage(key, ['Quick']), '203.0.113.10')).text, 'Answer to: Quick (copy 1)');
  await new Promise(r => setTimeout(r, 80));
  assert.equal(h.calls, 1);
  // One that fails at once is not asked again.
  h.calls = 0; h.mode = 'down';
  assert.equal((await answer(ask, await fromPage(key, ['While it is down']), '203.0.113.10')).status, 503);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(h.calls, 1);
  assert.equal(ask.left('203.0.113.10'), 2, 'three answers counted, however many copies went');
  assert.deepEqual(await today(), { asks: 3, askers: 1, capped: 0, went: 0 });
});

test('a key just made is used for nothing until the provider takes it; a key kept from before is not waited for', async () => {
  const { ask, provider, h } = await setup();
  h.refusals = 2;
  const [key, answered] = await Promise.all([ask.key(), ask.key().then(async k => ask.ask((await fromPage(k, ['Asked as the key was made'])).body, '203.0.113.8'))]);
  assert.equal(key, h.keys.publicHex, 'the first page gets its key, a little later');
  assert.equal(answered.status, 200);
  assert.equal(h.warmed, 4, 'refused twice, taken, then asked for the pages once');
  // After a restart the key is the one kept: a refusal then is not a new key settling.
  const later = hardware();
  later.refusals = 1;
  const again = asking.create({ db, env: ENV, includedAi: includedAi.create({ db, env: ENV, request: provider.request }), near: later.near, newKeyWait: 1 });
  await assert.rejects(again.key(), { status: 401 });
  assert.equal(later.warmed, 1);
});

test('closedhand.com\'s key for the questions is kept sealed across restarts, and the proven key is asked for once a minute at most', async () => {
  let at = Date.parse('2026-03-03T10:00:00Z');
  const { ask, provider, h } = await setup({ clock: () => at });
  await Promise.all([ask.key(), ask.key(), ask.key()]);
  await ask.key();
  assert.equal(h.warmed, 2, 'once to see the new key taken and once for the pages, however many open');
  at += 61000;
  await ask.key();
  assert.equal(h.warmed, 3);
  assert.equal(provider.keys.size, 1);
  const [id, made] = [...provider.keys.entries()][0];
  assert.equal(made.name, 'Closedhand questions');
  assert.equal(made.limit, 20);
  const row = (await db.query('SELECT key_id, sealed FROM site_ask_key')).rows[0];
  assert.equal(row.key_id, id);
  assert.ok(!row.sealed.includes(made.key), 'never in the clear');

  // A restart: the same key, none made or deleted.
  const again = includedAi.create({ db, env: ENV, request: provider.request });
  assert.equal((await again.forAsking()).key, made.key);
  assert.deepEqual([...provider.keys.keys()], [id]);
});

test('with no uncensored LLM to offer, or a day\'s total of none, the box is off', async () => {
  const none = asking.create({ db, env: ENV, includedAi: includedAi.create({ db, env: { TOKEN_ENCRYPTION_KEY: ENV.TOKEN_ENCRYPTION_KEY }, request: nearAi().request }), near: hardware().near });
  assert.equal(none.on(), false);
  assert.deepEqual((await none.ask({}, '203.0.113.4')).body, { error: 'off' });
  const { ask } = await setup({ env: { ASK_PER_DAY: '0' } });
  assert.equal(ask.on(), false);
});

test('the routes: the key and what is left, an answer, and going on to the download counted once for someone who asked', async () => {
  const { ask } = await setup();
  const app = require('express')();
  app.use(require('express').json());
  ask.register(app);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const at = 'http://127.0.0.1:' + server.address().port;
  try {
    const went = () => fetch(at + '/api/ask/went', { method: 'POST' }).then(r => r.json());
    await went();
    assert.equal((await today()).went, 0, 'someone who never asked is not counted');
    const hello = await (await fetch(at + '/api/ask')).json();
    assert.deepEqual([hello.left, hello.of, hello.name], [5, 5, 'DeepSeek V4.1 Flash Abliterated']);
    const { mine, body } = await fromPage(hello.key, ['Asked over the wire']);
    const post = sent => fetch(at + '/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sent) });
    const res = await post(body);
    assert.equal(res.headers.get('cache-control'), 'no-store, no-transform');
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const events = (await res.text()).split('\n\n').filter(Boolean).map(e => JSON.parse(e.replace(/^data: /, '')));
    assert.deepEqual(events.at(-1), { done: true, left: 4 }, 'how it ended comes last');
    let text = '';
    for (const e of events.slice(0, -1)) text += await page.open(e.c, mine.secret);
    assert.equal(text, 'Answer to: Asked over the wire');
    // A request that gets no answer is told so in JSON, with its status.
    const refused = await post({ ...body, key: 'no key' });
    assert.deepEqual([refused.status, refused.headers.get('content-type').split(';')[0], (await refused.json()).error], [400, 'application/json', 'That request could not be read.']);
    assert.equal((await (await fetch(at + '/api/ask')).json()).left, 4);
    await went(); await went();
    assert.equal((await today()).went, 1);
    assert.deepEqual((await ask.days()).map(d => [d.asks, d.askers, d.went]), [[1, 1, 1]]);
  } finally { server.close(); }
});

test('the page: the box and its script are on the home page, and what it says is true of what it does', () => {
  const home = fs.readFileSync(path.join(__dirname, '..', 'views', 'home.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'ask.js'), 'utf8');
  assert.match(home, /<script src="\/ask-private\.js" defer><\/script><script src="\/ask\.js" defer><\/script>/);
  assert.match(home, /id="askInput"[^>]*maxlength="500"/);
  // The conversation is kept in this browser only, under one key, to be carried into Closedhand
  // (test/carry.js); nothing else is stored, and the page only talks to closedhand.com's two routes.
  assert.deepEqual([...new Set(script.match(/localStorage\.\w+\(\w+/g))].sort(), ['localStorage.getItem(KEY', 'localStorage.removeItem(KEY', 'localStorage.setItem(KEY']);
  assert.doesNotMatch(script, /sessionStorage|document\.cookie|indexedDB/);
  assert.deepEqual([...new Set(script.match(/fetch\('[^']+'/g))].sort(), ["fetch('/api/ask'", "fetch('/api/ask/went'"]);
  // Each example is one the LLM can answer with nothing of the person's.
  const tries = [...home.matchAll(/<button type="button">([^<]+)<\/button>/g)].map(m => m[1]).filter(t => /\?|\.$/.test(t));
  assert.ok(tries.length >= 2 && tries.every(t => !/\bmy\b|\bme\b/i.test(t)), 'no example needs their mail, calendar or files');
  // The box says nothing of how it is private: the line below it on the page does. It is one piece: in
  // its own foot, how many questions are left, after an answer one quiet line on what Closedhand adds
  // (the way to the download on a computer, the link sent on a phone), and Send.
  assert.match(home, /<div class="ask-foot"><div class="ask-foot-info"><p class="ask-note" id="askNote"><\/p><span id="askUnlockSlot"><\/span><\/div><button type="submit" class="ask-send" id="askSend" disabled>/);
  assert.doesNotMatch(home + script, /Encrypted in your browser|Download below|Generate images, take actions/);
  // What it unlocks, by the names people know, in one line: no pills.
  assert.match(script, /var UNLOCKS = 'image generation, agentic actions and anything you connect';/);
  assert.match(script, /unlock\.textContent = handheld \? 'Send yourself the link for ' \+ UNLOCKS : 'Get ' \+ UNLOCKS;/);
  assert.match(script, /unlock\.addEventListener\('click', handheld \? sendLink : down\);/);
  assert.doesNotMatch(home + script, /ask-chip/);
  // How many questions are left: a mark for each and the same in words, never a zero.
  assert.match(script, /line\.textContent = \(state\.left === 1 \? 'One question' : state\.left \+ ' questions'\) \+ ' left here today';/);
  assert.match(script, /if \(!\(state\.left > 0\)\) \{ note\.hidden = true; return; \}/);
  assert.match(script, /next = document\.createElement\(handheld \? 'div' : 'button'\);/);
  // Accuracy and honesty come first: nothing invented, "I don't know" said plainly, working shown and
  // mistakes put right. Then it answers as asked, unkind questions too, and gives its own pick, well
  // known or obscure. Rules for kinds of question, never for one question, and none that push it to
  // sound sure: those made it invent a year for a disaster that never happened.
  assert.match(asking.INSTRUCTION, /Accuracy and honesty come first\. Say only what you know to be true: never invent a fact, a figure, a date or a detail/);
  assert.match(asking.INSTRUCTION, /when you do not know, or the thing asked about does not exist as far as you know, say so plainly/);
  assert.match(asking.INSTRUCTION, /Work a sum or a count through in the open when that gets it right, and if you find you were wrong, say so and put it right\./);
  assert.match(asking.INSTRUCTION, /A blunt, rude or unkind question is theirs to ask: answer it as asked, about real people and groups too/);
  // Saying what is uncertain is honest and welcome, after its view and never in its place.
  assert.match(asking.INSTRUCTION, /open with your own, well known or obscure, whichever you would stand behind, and give the reason\. Your view comes first; whatever is uncertain or arguable about it can follow, and never takes its place\./);
  assert.doesNotMatch(asking.INSTRUCTION, /never answer that it is subjective/);
  assert.doesNotMatch(asking.INSTRUCTION, /most people would agree|one name|expect over anything obscure|settled answer|nothing taken back|keep it/);
  // Asked for an image or anything else only Closedhand does, it never says Closedhand cannot, and gives a
  // taste from here before the download that does it for real: answers that opened on "I can't see your inbox"
  // and stopped there were a dead end.
  assert.match(asking.INSTRUCTION, /it generates images, takes actions for them and works with their mail, calendar, files and whatever else they connect/);
  // Where it runs, so it never says it runs on their computer or that nothing leaves it.
  assert.match(asking.INSTRUCTION, /Two things set you apart from other assistants, and asked what you are or what you can do, say both: you answer what they refuse, and you run in a TEE at a company that provides private inference, away from their computer: what they send you leaves it encrypted, and nobody but them can read it, not closedhand\.com and not the company running that hardware\. Say nothing about what that company keeps or logs\./);
  assert.match(asking.INSTRUCTION, /never say that Closedhand cannot do it, and never open with what you cannot do: first give what you can from here, such as how it would go about it or a taste of the answer, without pretending to know anything of theirs, then say in one sentence that downloading Closedhand, below on this page, does it for real/);
  // And only then: an answer it can give here carries no line about downloading.
  assert.match(asking.INSTRUCTION, /Say that only then: a question you can answer here gets its answer alone, with no mention of downloading\.$/);
  // A page left open over a night or a restart holds more conversation than closedhand.com takes:
  // it sends the latest of it, never a request that can only be turned away.
  assert.match(script, /turns = turns\.slice\(-\(Math\.max\(1, state\.of\) \* 2 - 1\)\);/);
  // Used up, the piece takes the box's place and the download card shows itself.
  assert.match(home, /\.ask\.done \.ask-next \{[^}]*border: 1\.5px solid rgba\(var\(--accent-strong-rgb\),0\.45\)/);
  assert.match(script, /note\.hidden = true;\n    call\(\);\n    if \(asked\) next\.scrollIntoView/);
  // Letters and their noise take turns, each sharp: nothing blurs, in the box or the ring.
  assert.doesNotMatch(home, /\.(ask|orb)-(real|noise|ch)[^{]*\{[^}]*blur/);
  // The LLM goes by its name, with "uncensored" beside it.
  assert.match(script, /state\.name \+ ', the uncensored LLM Closedhand provides'/);
});

test('the questions to try drift past in one line, scrolled not slid, held for a finger, the pointer and the keyboard, still for reduced motion, and each asks', () => {
  const home = fs.readFileSync(path.join(__dirname, '..', 'views', 'home.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'ask.js'), 'utf8');
  const tries = home.match(/<div class="ask-tries computer-only" id="askTries"[^>]*>\s*<div class="ask-tries-track">([\s\S]*?)<\/div>\s*<\/div>/);
  assert.ok(tries, 'on computers only: on phones and tablets the ring turns through questions');
  assert.ok(tries, 'one track of questions');
  assert.ok((tries[1].match(/<button type="button">/g) || []).length >= 6, 'a mix, so none leads');
  // Scrolled, never slid: iPhone Safari left parts of a wide sliding strip undrawn.
  assert.doesNotMatch(home, /tries-drift|\.ask-tries-track \{[^}]*animation/);
  assert.match(home, /\.ask-tries \{[^}]*overflow-x: auto;/);
  assert.match(script, /tries\.scrollLeft = pos;/);
  assert.match(script, /In a new order each visit, so no question always comes first\./);
  assert.ok(script.indexOf('Math.random()') < script.indexOf("copy.setAttribute('aria-hidden'"), 'shuffled before the copies are made, so the loop still matches');
  assert.match(script, /prefers-reduced-motion: reduce/, 'still for reduced motion');
  for (const held of ["'pointerenter', hold", "'focusin', hold", "'touchstart', hold"]) assert.ok(script.includes(held), 'held: ' + held);
  assert.match(script, /copy\.setAttribute\('aria-hidden', 'true'\); copy\.tabIndex = -1;/, 'the copies that close the loop are hidden from screen readers and the keyboard');
  assert.match(script, /tries\.addEventListener\('click', function \(e\) \{/, 'one listener, so the copies ask too');
});
