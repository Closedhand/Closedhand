// Prompt caching: marked for Anthropic, which caches only what is marked;
// never sent to providers that cache a repeated prompt start by themselves.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const wire = require('../lib/model-wire');
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });
function capture(reply) {
  const sent = [];
  global.fetch = async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => reply }; };
  return sent;
}
const anthropic = { backend: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k', model: 'claude-x' };
const tools = [{ name: 'search_cache', description: 'Search', input_schema: { type: 'object', properties: {} } }];
const toolLoop = () => [
  { role: 'user', content: 'What is on today?' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search_cache', input: { query: 'today' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"items":[]}' }] },
];
const marks = body => JSON.stringify(body).split('"cache_control"').length - 1;

test('a first message: the system prompt and the tools before it are marked, the conversation is not', async () => {
  const sent = capture({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} });
  await wire.request(anthropic, { system: 'You are Closedhand.', messages: [{ role: 'user', content: 'hi' }], tools });
  const { body } = sent[0];
  assert.deepEqual(body.system, [{ type: 'text', text: 'You are Closedhand.', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(body.tools.at(-1).cache_control, { type: 'ephemeral' }, 'a changed system prompt alone still reads the tools from cache');
  assert.equal(marks(body), 2);
  assert.equal(JSON.stringify(tools).includes('cache_control'), false, 'the caller keeps its own tools unmarked');
});
test('mid-task, after tool results, the conversation so far is marked too, without touching the caller\'s messages', async () => {
  const sent = capture({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} });
  const messages = toolLoop();
  await wire.request(anthropic, { system: 'You are Closedhand.', messages, tools });
  const last = sent[0].body.messages.at(-1).content.at(-1);
  assert.deepEqual(last.cache_control, { type: 'ephemeral' });
  assert.equal(marks(sent[0].body), 3);
  assert.equal(JSON.stringify(messages).includes('cache_control'), false, 'the caller keeps its own copy unmarked');
});
test('a caller\'s own marks are kept, never doubled, and never more than four in all', async () => {
  const sent = capture({ content: [], stop_reason: 'end_turn', usage: {} });
  const system = [{ type: 'text', text: 'static', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'time and recall' }];
  await wire.request(anthropic, { system, messages: toolLoop(), tools });
  assert.equal(sent[0].body.system[1].cache_control, undefined, 'the changing tail stays unmarked');
  assert.equal(marks(sent[0].body), 3);
  const crowded = toolLoop();
  crowded.slice(0, 2).forEach(m => { if (Array.isArray(m.content)) m.content[0].cache_control = { type: 'ephemeral' }; });
  crowded[0] = { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }] };
  await wire.request(anthropic, { system, messages: crowded, tools });
  assert.ok(marks(sent[1].body) <= 4);
});
test('OpenAI-style services and Gemini get the same prompt with no caching marks', async () => {
  for (const [conn, reply] of [
    [{ backend: 'custom', baseUrl: 'https://api.deepinfra.com/v1/openai', apiKey: 'k', model: 'm' }, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }],
    [{ backend: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-x' }, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }],
    [{ backend: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'k', model: 'gemini-x' }, { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }],
  ]) {
    const sent = capture(reply);
    await wire.request(conn, { system: [{ type: 'text', text: 'You are Closedhand.', cache_control: { type: 'ephemeral' } }], messages: toolLoop(), tools });
    assert.equal(marks(sent[0].body), 0, conn.backend);
    assert.ok(JSON.stringify(sent[0].body).includes('You are Closedhand.'), conn.backend);
  }
});

// What changes per message rides in front of the newest request
// (lib/engine.js withTurnContext), so the system prompt and the earlier
// conversation are the same from one message to the next and can be reused
// from cache, on every provider. The person's own words stay last.
const vm = require('node:vm');
const engineSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'engine.js'), 'utf8');
const box = {};
vm.runInNewContext(engineSrc.slice(engineSrc.indexOf('const CACHE_MARK = '), engineSrc.indexOf('\n}\n', engineSrc.indexOf('function withTurnContext(')) + 3) + '\nthis.place = withTurnContext;', box);
const SYSTEM = [{ type: 'text', text: 'You are Closedhand.', cache_control: { type: 'ephemeral' } }];
const contextFor = (minute) => `Current time: 09:0${minute}. LANGUAGE: reply in English.`;
const firstMessage = [{ role: 'user', content: 'Book the usual table' }, { role: 'assistant', content: 'Done, 7pm at Rosa\'s.' }, { role: 'user', content: 'Thanks, and remind me at 6' }];
const nextMessage = [...firstMessage, { role: 'assistant', content: 'Reminder set for 6pm.' }, { role: 'user', content: 'What about Friday?' }];

test('the per-message part goes in front of the newest request, the user\'s words last, and the stored conversation is untouched', () => {
  const before = JSON.stringify(nextMessage);
  const placed = box.place(nextMessage, contextFor(1));
  assert.equal(JSON.stringify(nextMessage), before);
  const last = placed.at(-1);
  assert.equal(last.role, 'user');
  assert.match(last.content[0].text, /^\[Closedhand context for this message, not written by the user\]\nCurrent time: 09:01/);
  assert.equal(JSON.stringify(last.content.at(-1)), JSON.stringify({ type: 'text', text: 'What about Friday?' }));
  assert.equal(JSON.stringify(placed.at(-2).content.at(-1).cache_control), JSON.stringify({ type: 'ephemeral' }), 'the end of the earlier conversation is marked');
  assert.equal(placed.slice(0, -2).some(m => JSON.stringify(m).includes('cache_control')), false);
  assert.equal(box.place([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '{}' }] }], 'x'), null, 'no request, no placement');
});

test('mid-task the context stays on the request, after tool calls, and Anthropic gets at most four marks', async () => {
  const sent = capture({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} });
  const loop = [...firstMessage, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search_cache', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] }];
  await wire.request(anthropic, { system: SYSTEM, messages: box.place(loop, contextFor(1)), tools });
  const body = sent[0].body;
  assert.equal(marks(body), 4, 'system, the earlier conversation, the step so far, the tools');
  assert.match(body.messages[2].content[0].text, /Closedhand context/);
  assert.equal(body.system.length, 1, 'the system prompt alone');
});

test('two messages in a row share the system prompt and the earlier conversation, on every provider', async () => {
  for (const [conn, reply] of [
    [anthropic, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} }],
    [{ backend: 'custom', baseUrl: 'https://api.deepinfra.com/v1/openai', apiKey: 'k', model: 'm' }, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }],
    [{ backend: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-x' }, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }],
    [{ backend: 'xai', baseUrl: 'https://api.x.ai/v1', apiKey: 'k', model: 'grok-x' }, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }],
    [{ backend: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'k', model: 'gemini-x' }, { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }],
  ]) {
    const sent = capture(reply);
    await wire.request(conn, { system: SYSTEM, messages: box.place(firstMessage, contextFor(1)), tools });
    await wire.request(conn, { system: SYSTEM, messages: box.place(nextMessage, contextFor(7)), tools });
    const [a, b] = sent.map(s => s.body);
    const strip = (x) => x === undefined ? null : JSON.parse(JSON.stringify(x, (k, v) => k === 'cache_control' ? undefined : v));
    const turns = (body) => strip(body.messages || body.contents);
    // Everything before the first message's request is sent again unchanged.
    const shared = conn.backend === 'gemini' || conn.backend === 'anthropic' ? 2 : 3; // OpenAI-style puts the system prompt first in messages
    assert.deepEqual(turns(b).slice(0, shared), turns(a).slice(0, shared), conn.backend);
    assert.deepEqual(strip(b.system || b.systemInstruction), strip(a.system || a.systemInstruction), conn.backend);
    const lastTurn = JSON.stringify(turns(b).at(-1));
    assert.ok(lastTurn.indexOf('Closedhand context') < lastTurn.indexOf('What about Friday?'), conn.backend + ': the user\'s words come last');
    assert.ok(!JSON.stringify(turns(b).slice(0, -1)).includes('09:07'), conn.backend + ': the clock is only on the newest request');
    if (conn.backend !== 'anthropic') assert.equal(marks(b), 0, conn.backend);
  }
});

// A reply that follows the last closely carries on from what that reply sent
// (lib/last-turn.js), marks and all, and each placement adds one. The fourth
// quick follow-up in a row went with five and Anthropic refused it ("A
// maximum of 4 blocks with cache_control may be provided"). Never more than
// four, the newest kept.
test('a run of carried-on follow-ups never sends more than four marks, and keeps the newest', async () => {
  const sent = capture({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} });
  let conversation = [{ role: 'user', content: 'The order for Sam Fixture' }, { role: 'assistant', content: 'Noted.' }];
  let last = null;
  for (let t = 1; t <= 6; t++) {
    conversation.push({ role: 'user', content: `follow-up ${t}` });
    let messages = last ? [...last, ...conversation.slice(-2)] : [...conversation];
    await wire.request(anthropic, { system: SYSTEM, messages: box.place(messages, contextFor(t % 10)), tools });
    messages = [...messages, { role: 'assistant', content: [{ type: 'tool_use', id: `t${t}`, name: 'search_cache', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${t}`, content: '{}' }] }];
    await wire.request(anthropic, { system: SYSTEM, messages: box.place(messages, contextFor(t % 10)), tools });
    const body = sent.at(-1).body;
    assert.ok(marks(body) <= 4, `follow-up ${t}: ${marks(body)} marks`);
    assert.deepEqual(body.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' }, 'the step so far stays marked');
    last = box.place(messages, contextFor(t % 10));
    conversation.push({ role: 'assistant', content: `answer ${t}` });
  }
  assert.ok(sent.every((s) => marks(s.body) <= 4), "every request");
});
