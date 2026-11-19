// The start of a request stays the same from one model call to the next, so
// the provider answers from its cache instead of reading everything again at
// full price: a tool only ever joins the end of the list, a turn carrying on
// after a yes keeps the context it had, and a background job's clock is the
// moment it began. And a connected server's tools load with the first call
// when the request names what they work on, so no call is spent looking one up.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('a background job\'s tools keep their order, a new one going at the end', () => {
  const { createToolScope } = require('../lib/task-tools');
  const all = ['zeta_tool', 'alpha_tool', 'get_tool_details', 'web_search', 'mid_tool'].map((name) => ({ name, description: name }));
  const scope = createToolScope(all, '');
  const asked = (tool_name) => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'get_tool_details', input: { tool_name } }] });
  const names = (messages) => scope.definitions(messages).map((t) => t.name);
  const first = names([]);
  const second = names([asked('zeta_tool')]);
  const third = names([asked('zeta_tool'), asked('alpha_tool')]);
  assert.deepEqual(second, [...first, 'zeta_tool']);
  assert.deepEqual(third, [...second, 'alpha_tool'], 'not sorted into the middle of the list');
  assert.deepEqual(names([asked('zeta_tool'), asked('alpha_tool'), asked('zeta_tool')]), third, 'and asked for twice it stays where it was');
});

test('a background job\'s prompt has the clock of when it began, whenever it is built', () => {
  const { buildAgentSystemPrompt } = require('../lib/agents');
  const store = { profile: { settings: {} }, location: { timezone: 'Europe/London', name: 'London' } };
  const began = new Date('2026-03-04T10:15:00Z');
  const realNow = Date.now;
  const a = buildAgentSystemPrompt('Find the invoice', store, 'web', { began });
  Date.now = () => realNow() + 7 * 60 * 1000;
  const b = buildAgentSystemPrompt('Find the invoice', store, 'web', { began });
  Date.now = realNow;
  assert.equal(a, b, 'the same prompt after a pause, so a resumed job is read from cache');
  assert.match(a, /That is when this job began; it can be some minutes later by now\./);
  const agents = read('lib/agents.js');
  assert.match(agents, /const began = await jobBegan\(taskId\);\n\s+const systemPrompt = buildAgentSystemPrompt\(goal, userStore, platform, \{ began \}\)/);
  assert.match(agents, /if \(kept && now - kept < SAME_CLOCK_MS && kept <= now\) return new Date\(kept\);/, 'kept with the job while it is recent, taken afresh after a long pause');
});

test('a background job follows the person\'s own rules, as the chat does', () => {
  const { buildAgentSystemPrompt } = require('../lib/agents');
  const withRules = buildAgentSystemPrompt('Write to the plumber', { profile: { settings: {} }, userRules: [{ rule: 'Never use emojis' }, 'Sign emails as R.'] });
  assert.match(withRules, /YOUR RULES \(set by this user, follow these always\):\n- Never use emojis\n- Sign emails as R\.\n/);
  assert.doesNotMatch(buildAgentSystemPrompt('Write to the plumber', { profile: { settings: {} } }), /YOUR RULES/);
  assert.match(read('lib/engine.js'), /require\("\.\/their-rules"\)\.rulesBlock\(userRules\)/, 'the chat says them with the same words');
});

test('a turn carrying on after a yes keeps the context it had, while the answer is recent', () => {
  const engine = read('lib/engine.js');
  assert.match(engine, /let turnContext = opts\.resume\?\.turnContext \|\| null;/);
  assert.match(engine, /request: userMessage,\n[^\n]*\n\s+turnContext,/, 'the question keeps the turn\'s context');
  assert.match(engine, /if \(!contextFetched && turnContext !== null\) \{[\s\S]{0,400}contextFetched = true;/, 'and recall is not run a second time for the same message');
  const conf = read('lib/confirmation.js');
  assert.match(conf, /const SAME_CONTEXT_MS = 10 \* 60 \* 1000;/);
  assert.match(conf, /turnContext: soon \? pending\.turnContext \|\| null : null/);
});

test('a connected server\'s tools load with the first call when the request names what they work on', () => {
  const { likelyMcpTools } = require('../lib/engine');
  const def = (name) => ({ name: 'umcp_office_' + name, description: 'd (office)', input_schema: { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(400) } } } });
  const named = ['calendar_add_event', 'calendar_delete_event', 'invoices_send_invoice', 'contacts_search_contacts', 'rooms_book_room'].map(def);
  const big = named.concat(Array.from({ length: 80 }, (_, i) => def('ledger_entry_' + i)));
  const pick = (message, conversation = []) => [...likelyMcpTools(message, conversation, big)].map((n) => n.replace('umcp_office_', ''));
  assert.deepEqual(pick('Move my dentist event to Friday and send the invoices to Dana').sort(), ['calendar_add_event', 'calendar_delete_event', 'invoices_send_invoice']);
  assert.deepEqual(pick('Please send it and delete the old one'), [], 'the verbs every tool has say nothing about which one');
  assert.deepEqual(pick('yes please', [{ role: 'assistant', content: 'Shall I book a room for it?' }]), ['rooms_book_room'], 'a short answer is read with what it answers');
  assert.equal(likelyMcpTools('hello', [], named).size, named.length, 'a small server loads whole');
  const within = [...likelyMcpTools('every ledger entry please', [], big)];
  assert.ok(within.length > 5 && within.length < 80, 'a big one loads within a size');
  assert.ok(within.reduce((n, name) => n + JSON.stringify(big.find((t) => t.name === name)).length, 0) <= 24000);
  assert.equal(likelyMcpTools('anything', [], []).size, 0);
  const full = new Set(within);
  assert.equal(likelyMcpTools('move my dentist event', [], big, full).size, 0, 'what the conversation loaded already counts towards the size');
  assert.match(read('lib/engine.js'), /for \(const name of likelyMcpTools\(userMessage, conversation, getUserMcpToolDefs\(userId\), loadedTools\)\) loadedTools\.add\(name\);/);
});
