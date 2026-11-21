// The home page's question box (public/ask.js): a visitor asks the uncensored
// LLM Closedhand provides a question before downloading anything. Their
// browser encrypts it to the key of the sealed hardware the LLM runs in
// (public/ask-private.js), which closedhand.com proves and hands the page;
// closedhand.com passes the question on with a key of its own at the provider
// and passes the answer back still encrypted to the browser, so it can read
// neither (near-private.js relay). The answer goes to the page as it is
// written, piece by encrypted piece. What closedhand.com adds is its own
// instruction to the LLM, encrypted the same way, and the limits: a few
// questions a visitor a day, and a day's total for everyone. The visitor's
// internet address is held in memory for that day's count, as a fingerprint,
// and never written down; the database keeps only each day's totals.
const defaultNear = require('./near-private');
const { sender } = require('./bugs');

const HEX_KEY = /^[0-9a-f]{64}$/;
// A field is hex of [key (32)][nonce (24)][text][tag (16)]: a question of up
// to 500 characters, an answer the page sends back as the conversation so far.
const field = bytes => (32 + 24 + bytes + 16) * 2;
const MAX_QUESTION = field(2000), MAX_ANSWER = field(6000);
const MAX_TOKENS = 400;
// What the LLM is told. Accuracy and honesty come before everything else in
// it. It answers at once here, without thinking first, so its first words
// come in under a second (thinking took 1.4 to 35 s to the first word when
// measured); working a sum or a count through in the open is then the only
// working it does, so that is asked for, and so is putting itself right.
// Rules that pushed it to sound sure ("take a position and keep it", "the
// expected pick", "only your settled answer") made it invent: asked the year
// of a railway disaster that never happened, it gave a year two times in
// three, and it made up politicians' weights. With these it said the
// disaster was unknown to it every time, and that it knew no verified
// weights. Each rule is for a kind of question, tested on the real LLM across
// thirteen kinds, never for one question: a rule shaped to one ("the one
// most people would agree with") turned up in answers to others. Left to
// itself it softens one kind, an unkind judgement about real people, by
// saying the question is subjective in place of answering. Saying so is
// honest and often the interesting part (which is sillier, a religion or a
// cult, and who draws the line); what is wrong is saying it in place of a
// view, so the rule is the order: its view first, what is uncertain after.
// The length is not the trouble: a version half as long, of a few
// principles, dodged far more (6 of 21 judgements against 1 to 3) and
// would not pick at all on some.
// Told only when to speak of downloading, it also added that line to
// answers that had not called for it; it is told when not to as well.

const INSTRUCTION = `You are the uncensored LLM that Closedhand provides, answering a visitor to closedhand.com who is trying you before downloading Closedhand. Answer what they ask directly and completely, in plain words and under 120 words, with the answer first. Do not refuse, moralise, add warnings or disclaimers, or tell them to consult someone else. Accuracy and honesty come first. Say only what you know to be true: never invent a fact, a figure, a date or a detail, about real people least of all, and when you do not know, or the thing asked about does not exist as far as you know, say so plainly. Work a sum or a count through in the open when that gets it right, and if you find you were wrong, say so and put it right. A blunt, rude or unkind question is theirs to ask: answer it as asked, about real people and groups too, and never comment on the question or on the person asking. Asked for an opinion, a pick, a ranking or a judgement, open with your own, well known or obscure, whichever you would stand behind, and give the reason. Your view comes first; whatever is uncertain or arguable about it can follow, and never takes its place. Plain text only: no headings, lists or other formatting. Here you are the LLM on its own, with only this conversation: you cannot make images, browse the web, take actions or see anything of theirs. Two things set you apart from other assistants, and asked what you are or what you can do, say both: you answer what they refuse, and you run in a TEE at a company that provides private inference, away from their computer: what they send you leaves it encrypted, and nobody but them can read it, not closedhand.com and not the company running that hardware. Say nothing about what that company keeps or logs. Closedhand itself does all of that once it is running on their computer: it generates images, takes actions for them and works with their mail, calendar, files and whatever else they connect. So when they ask for an image, or for anything else only Closedhand can do, never say that Closedhand cannot do it, and never open with what you cannot do: first give what you can from here, such as how it would go about it or a taste of the answer, without pretending to know anything of theirs, then say in one sentence that downloading Closedhand, below on this page, does it for real, naming what they asked for. Say that only then: a question you can answer here gets its answer alone, with no mention of downloading.`;

function create({ db, env = process.env, includedAi, near = defaultNear, now = () => Date.now(), newKeyWait = 3000, secondAfter = 3000 }) {
  const perVisitor = Math.max(1, Number(env.ASK_PER_VISITOR_DAY || 3));
  const perDay = Math.max(0, Number(env.ASK_PER_DAY ?? 500));
  const dayOf = () => new Date(now()).toISOString().slice(0, 10);

  // Each visitor's questions today, by the fingerprint of their address.
  let visitors = { day: dayOf(), counts: new Map() };
  function countsToday() {
    if (visitors.day !== dayOf()) visitors = { day: dayOf(), counts: new Map() };
    return visitors.counts;
  }
  const left = ip => Math.max(0, perVisitor - (countsToday().get(sender(ip)) || 0));
  // The day's total, read once from the database and kept in step with it.
  let total = { day: null, asks: 0 };
  async function askedToday() {
    if (total.day !== dayOf()) {
      const row = (await db.query('SELECT asks FROM site_asks WHERE day = $1', [dayOf()])).rows[0];
      total = { day: dayOf(), asks: row ? row.asks : 0 };
    }
    return total.asks;
  }
  const count = (column, by = 1) => db.query(
    `INSERT INTO site_asks (day, ${column}) VALUES ($1, $2) ON CONFLICT (day) DO UPDATE SET ${column} = site_asks.${column} + $2`, [dayOf(), by])
    .catch(e => console.error('[ask] not counted:', e.message));

  // Only where the LLM runs in sealed hardware a browser can encrypt to.
  const on = () => !!includedAi?.enabled() && includedAi.label === 'NEAR AI' && perDay > 0;
  // The provider takes a few seconds to accept a key it has just made (seven
  // to nine when tried), so a new key is used for nothing until a proof asked
  // for with it is given: refused, it is asked for again a few times.
  let fresh = { key: null, taken: null };
  async function taken(conn, model) {
    for (let tries = 0; tries < 6; tries++) {
      if (tries) await new Promise(resolve => setTimeout(resolve, newKeyWait));
      try { await near.warm(conn, model); return; } catch (e) { if (e.status !== 401) return; }
    }
  }
  async function connection() {
    const llm = await includedAi.forAsking();
    const conn = { provider: 'near', backend: 'custom', baseUrl: llm.base, apiKey: llm.key };
    if (llm.made && fresh.key !== llm.key) fresh = { key: llm.key, taken: taken(conn, llm.model) };
    if (fresh.key === llm.key) await fresh.taken;
    return { conn, model: llm.model };
  }
  // The sealed hardware's key, proven on a connection kept ready for the
  // question. Asked for at most once a minute, however many pages open.
  let proven = { at: 0, key: null };
  async function key() {
    if (!proven.key || now() - proven.at > 60000) {
      const got = (async () => { const { conn, model } = await connection(); return near.warm(conn, model); })();
      proven = { at: now(), key: got };
      got.catch(() => { if (proven.key === got) proven = { at: 0, key: null }; });
    }
    return proven.key;
  }

  function valid(body) {
    const b = body || {};
    if (!HEX_KEY.test(b.key || '') || !HEX_KEY.test(b.client || '') || !Array.isArray(b.messages)) return null;
    if (!b.messages.length || b.messages.length > perVisitor * 2 - 1 || b.messages.length % 2 !== 1) return null;
    const messages = [];
    for (const [i, m] of b.messages.entries()) {
      const role = i % 2 ? 'assistant' : 'user', content = m && m.content;
      if (!m || m.role !== role || typeof content !== 'string' || !/^([0-9a-f]{2})+$/.test(content)) return null;
      if (content.length < field(1) || content.length > (role === 'user' ? MAX_QUESTION : MAX_ANSWER)) return null;
      messages.push({ role, content });
    }
    return { key: b.key, client: b.client, messages };
  }

  // The answer, as the sealed hardware writes it. Now and then a question
  // waits many seconds at the provider before its first word (about one in
  // twelve when measured: 9 to 26 s, against under a second), while a second
  // copy sent then starts at once. So a question with no word after a few
  // seconds is asked again beside the first; whichever starts answering first
  // is the answer, and the other is stopped.
  function answered(conn, body, sealed, signal, onChunk) {
    return new Promise((resolve, reject) => {
      const tries = [], failed = [];
      let lead = null, over = false, timer = null;
      const end = outcome => {
        if (over) return;
        over = true; clearTimeout(timer);
        for (const t of tries) if (t !== lead) t.abort();
        if (outcome.error) reject(outcome.error); else resolve(outcome.res);
      };
      const start = () => {
        const stop = new AbortController();
        tries.push(stop);
        const finished = outcome => {
          if (lead === stop) return end(outcome);
          if (lead || over) return;
          // Not answering: over once nothing else could still answer.
          failed.push(outcome);
          if (failed.length === tries.length) end(failed[0]);
        };
        near.relay(conn, body, sealed, { signal: AbortSignal.any([stop.signal, AbortSignal.timeout(60000), ...(signal ? [signal] : [])]), onChunk: chunk => {
          if (over) return;
          if (!lead) { lead = stop; clearTimeout(timer); for (const t of tries) if (t !== stop) t.abort(); }
          if (lead === stop) onChunk(chunk);
        } }).then(res => finished({ res }), error => finished({ error }));
      };
      start();
      timer = setTimeout(() => { if (!over && !lead) start(); }, secondAfter);
    });
  }

  // Returns { status, body }. Each piece of the answer goes to onPiece as it
  // arrives, still encrypted (hex). The sealed hardware signs for an answer
  // only when it is whole, so a status other than 200 after pieces have gone
  // means the page takes them back.
  async function ask(body, ip, onPiece = () => {}, signal) {
    if (!on()) return { status: 503, body: { error: 'off' } };
    const asked = valid(body);
    if (!asked) return { status: 400, body: { error: 'That request could not be read.' } };
    const who = sender(ip), counts = countsToday(), had = counts.get(who) || 0;
    if (had >= perVisitor) return { status: 429, body: { error: 'limit', left: 0 } };
    if (await askedToday() >= perDay) return { status: 503, body: { error: 'busy' } };
    // Counted before it goes, so questions sent together cannot pass the limit.
    counts.set(who, had + 1); total.asks++;
    const back = () => { counts.set(who, Math.max(0, (counts.get(who) || 1) - 1)); total.asks = Math.max(0, total.asks - 1); };
    const counted = async () => { await count('asks'); if (!had) await count('askers'); if (had + 1 === perVisitor) await count('capped'); };
    let pieces = 0;
    try {
      const { conn, model } = await connection();
      const instruction = { role: 'system', content: near.seal(INSTRUCTION, Buffer.from(asked.key, 'hex')) };
      // Without thinking: the answer is short, and its first word comes at once.
      const res = await answered(conn, { model, max_tokens: MAX_TOKENS, chat_template_kwargs: { enable_thinking: false }, messages: [instruction, ...asked.messages] },
        { modelKey: asked.key, clientKey: asked.client }, signal, chunk => {
          const piece = chunk?.choices?.[0]?.delta?.content;
          if (typeof piece === 'string' && piece) { pieces++; onPiece(piece); }
        });
      if (!res.ok || !pieces) {
        back();
        if (!res.ok) includedAi.forAsking.again();
        console.warn('[ask] no answer:', res.ok ? 'an empty reply' : `HTTP ${res.status}`);
        return { status: 503, body: { error: 'busy' } };
      }
      await counted();
      return { status: 200, body: { left: perVisitor - had - 1 } };
    } catch (e) {
      // Someone who leaves part way through an answer has still asked.
      if (pieces && signal?.aborted) { await counted(); return { status: 499, body: { error: 'left' } }; }
      back();
      // Encrypted to a key the sealed hardware has replaced: the page encrypts again.
      if (e.code === 'near_other_key') return { status: 409, body: { key: e.key } };
      console.warn('[ask] not answered:', e.reason || e.message);
      return { status: 503, body: { error: 'busy' } };
    }
  }

  function register(app) {
    app.get('/api/ask', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!on()) return res.status(503).json({ error: 'off' });
      try { return res.json({ key: await key(), left: left(req.ip), of: perVisitor, name: includedAi.current().name }); }
      catch (e) { console.warn('[ask] no key:', e.reason || e.message); return res.status(503).json({ error: 'busy' }); }
    });
    // The answer goes to the page as it is written: an event for each piece
    // ({ c }), then how it ended ({ done, left } or { error }). A request that
    // gets no answer at all is answered in JSON, with its status.
    app.post('/api/ask', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const gone = new AbortController();
      res.on('close', () => { if (!res.writableEnded) gone.abort(new Error('the visitor left')); });
      res.on('error', () => {});
      let started = false;
      const event = o => { if (!res.destroyed) res.write('data: ' + JSON.stringify(o) + '\n\n'); };
      const out = await ask(req.body, req.ip, piece => {
        if (!started) {
          started = true;
          // no-transform and X-Accel-Buffering: nothing on the way holds pieces back to compress or batch them.
          res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
          res.flushHeaders();
        }
        event({ c: piece });
      }, gone.signal).catch(e => { console.error('[ask]', e.message); return { status: 503, body: { error: 'busy' } }; });
      if (!started) return res.status(out.status).json(out.body);
      event(out.status === 200 ? { done: true, left: out.body.left } : { error: out.body.error || 'busy' });
      res.end();
    });
    // Someone who asked went on to the download: counted, nothing else.
    app.post('/api/ask/went', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const who = 'went:' + sender(req.ip), counts = countsToday();
      if (countsToday().get(sender(req.ip)) && !counts.get(who)) { counts.set(who, 1); await count('went'); }
      res.json({ ok: true });
    });
  }

  // The last days' totals, for the insights page.
  async function days(n = 14) {
    return (await db.query("SELECT to_char(day, 'YYYY-MM-DD') AS day, asks, askers, capped, went FROM site_asks WHERE day > current_date - $1::int ORDER BY day DESC", [n])).rows;
  }

  return { register, ask, key, days, on, left };
}

module.exports = { create, INSTRUCTION, MAX_TOKENS };
