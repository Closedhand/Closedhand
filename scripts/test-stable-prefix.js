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
  // The prompt builder needs the whole app; what makes its clock stand still
  // is tested here by itself, and that the builder uses it, by reading it.
  const { currentTimeContext } = require('../lib/time-context');
  const store = { profile: { settings: {} }, location: { timezone: 'Europe/London', name: 'London' } };
  const began = new Date('2026-03-04T10:15:00Z');
  const realNow = Date.now;
  const a = currentTimeContext(store, began).text;
  Date.now = () => realNow() + 7 * 60 * 1000;
  const b = currentTimeContext(store, began).text;
  Date.now = realNow;
  assert.equal(a, b, 'the same words after a pause, so a resumed job is read from cache');
  const agents = read('lib/agents.js');
  assert.match(agents, /currentTimeContext\(userStore, began \|\| new Date\(\)\)\.text\}\$\{began \? "\\nThat is when this job began; it can be some minutes later by now\." : ""\}/);
  assert.match(agents, /const began = await jobBegan\(taskId\);/);
  assert.match(agents, /: buildAgentSystemPrompt\(goal, userStore, platform, \{ began \}\) \+ toolScope\.catalog/);
  assert.match(agents, /if \(kept && now - kept < SAME_CLOCK_MS && kept <= now\) return new Date\(kept\);/, 'kept with the job while it is recent, taken afresh after a long pause');
});

test('a background job follows the person\'s own rules, as the chat does', () => {
  const { rulesBlock } = require('../lib/their-rules');
  assert.equal(rulesBlock([{ rule: 'Never use emojis' }, 'Sign emails as R.']), 'YOUR RULES (set by this user, follow these always):\n- Never use emojis\n- Sign emails as R.\n');
  assert.equal(rulesBlock([]), '');
  assert.equal(rulesBlock(undefined), '');
  assert.match(read('lib/agents.js'), /const rules = require\("\.\/their-rules"\)\.rulesBlock\(userStore\?\.userRules\);\n\s+if \(rules\) prompt \+= "\\n\\n" \+ rules;/, 'the background job\'s prompt carries them');
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
  const { likelyMcpTools } = require('../lib/connected-tools');
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
  const engine = read('lib/engine.js');
  assert.match(engine, /for \(const name of likelyMcpTools\(userMessage, conversation, getUserMcpToolDefs\(userId\), loadedTools, room, room === MCP_LOAD_CACHED_CHARS \? room : room \/ 2\)\) loadedTools\.add\(name\);/);

  // A provider seen to answer from its cache: a server's tools whole where they fit.
  assert.equal(likelyMcpTools('thanks!', [], big, new Set(), 120000, 120000).size, big.length, 'the whole server when there is room for it');
  assert.equal(likelyMcpTools('thanks!', [], big, new Set(), 24000).size, 0, 'and only what the request names when there is not');
  const huge = big.concat(Array.from({ length: 300 }, (_, i) => def('archive_record_' + i)));
  assert.equal(likelyMcpTools('thanks!', [], huge, new Set(), 120000, 120000).size, 0, 'a server past the room still loads by what the request names');
  assert.match(engine, /if \(mcpRoom === 0\) \{\n\s+const room = _readsFromCache\.has\(cacheKey\) \? MCP_LOAD_CACHED_CHARS : MCP_LOAD_CHARS;/, 'more room when the provider is known to read from cache, chosen with a reply\'s first call (scripts/test-cache-steady.js)');
  assert.match(engine, /if \(\(response\.usage\?\.cache_read_input_tokens \|\| 0\) > 0\) _readsFromCache\.add\(cacheKey\);/);
});

test('a reply handed to the background carries on as the chat\'s own request, with one note at the end', () => {
  const { carriedMessages, carriedTools, CARRIED_ON } = require('../lib/task-evidence');
  const chat = {
    system: [{ type: 'text', text: 'You are Closedhand.', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'search_cache', description: 's', input_schema: {} }, { name: 'umcp_office_calendar_get_events', description: 'c', input_schema: {} }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '[Closedhand context for this message]' }, { type: 'text', text: 'Who is free on Friday?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'umcp_office_calendar_get_events', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '[]' }] },
    ],
  };
  const messages = carriedMessages(chat);
  assert.deepEqual(messages.slice(0, 2), chat.messages.slice(0, 2), 'everything before the note is exactly what the chat sent, so it is read from cache');
  assert.equal(messages.length, 3, 'the note joins the last message rather than making two in a row from the same side');
  assert.deepEqual(messages[2].content[0], chat.messages[2].content[0], 'tool results stay first in their message');
  assert.equal(messages[2].content[1].text, CARRIED_ON);
  assert.equal(chat.messages[2].content.length, 1, 'the chat\'s own copy is not changed');
  assert.equal(carriedMessages({ messages: [{ role: 'assistant', content: 'Looking.' }] }).at(-1).role, 'user');

  const scope = { has: (n) => ['save_report', 'umcp_office_rooms_book'].includes(n), describe: (n) => ({ name: n, description: 'd', input_schema: {}, note: 'x' }) };
  const names = (msgs) => carriedTools(chat, scope, msgs).map((t) => t.name);
  assert.deepEqual(names(messages), ['search_cache', 'umcp_office_calendar_get_events'], 'the chat\'s tools as they were, nothing added at the start');
  const more = [...messages, { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'get_tool_details', input: { tool_name: 'umcp_office_rooms_book' } }, { type: 'tool_use', id: 't3', name: 'get_tool_details', input: { tool_name: 'bridge_shell_run' } }] }];
  assert.deepEqual(names(more), ['search_cache', 'umcp_office_calendar_get_events', 'umcp_office_rooms_book'], 'one it reaches for later goes at the end; one a background job may not use is not added');
  assert.equal(carriedTools(chat, scope, more)[2].note, undefined);

  const engine = read('lib/engine.js'), agents = read('lib/agents.js');
  assert.match(engine, /if \(lastSent\) snapshot\.chat = \{ system: lastSent\.system, tools: lastSent\.tools, messages: lastSent\.place\(messages\) \};/);
  assert.match(agents, /const carried = resumeState\?\.runtime\?\.request\?\.chat \|\| null;\n\s+const systemPrompt = carried \? carried\.system/);
  assert.match(agents, /tools: carried \? require\("\.\/task-evidence"\)\.carriedTools\(carried, toolScope, messages\) : toolScope\.definitions\(messages\),/);
});

test('a message that follows the last reply closely carries on from what that reply sent and read', () => {
  const { rememberTurn, carriedTurn, forgetTurn } = require('../lib/last-turn');
  const sent = [
    { role: 'user', content: [{ type: 'text', text: '[Closedhand context for this message]' }, { type: 'text', text: 'Email Tomas to ask about Friday.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'gmail_send', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"id":"m-81"}' }] },
  ];
  const t0 = Date.parse('2026-03-04T10:00:00Z');
  const conversation = [{ role: 'user', content: 'Email Tomas to ask about Friday.' }, { role: 'assistant', content: 'Sent.' }];
  rememberTurn('u1', null, sent, 'Sent.', t0);
  conversation.push({ role: 'user', content: 'He says Saturday. Move the dinner.' });
  const next = carriedTurn('u1', null, conversation, t0 + 60000);
  assert.deepEqual(next.slice(0, 3), sent, 'what the last reply sent, unchanged, so the provider reads it from cache');
  assert.deepEqual(next.slice(3), conversation.slice(1), 'then its reply and what has been said since, the new message last');
  assert.equal(carriedTurn('u1', 'another-thread', conversation, t0 + 60000), null, 'only in its own conversation');
  assert.equal(carriedTurn('u1', null, conversation, t0 + 11 * 60000), null, 'and only for a few minutes: what was read goes stale');
  rememberTurn('u1', null, sent, 'Sent.', t0);
  assert.equal(carriedTurn('u1', null, [{ role: 'user', content: 'Hello' }], t0 + 1000), null, 'not once its reply has left the conversation');
  rememberTurn('u1', null, [{ role: 'user', content: 'x'.repeat(400000) }], 'Done.', t0);
  assert.equal(carriedTurn('u1', null, [{ role: 'assistant', content: 'Done.' }, { role: 'user', content: 'and?' }], t0 + 1000), null, 'not when it is too much to carry');
  rememberTurn('u1', null, sent, 'Sent.', t0); forgetTurn('u1', null);
  assert.equal(carriedTurn('u1', null, conversation, t0 + 1000), null);
  const engine = read('lib/engine.js');
  assert.match(engine, /const carried = opts\.resume \|\| isQuick \? null : carriedTurn\(userId, ctx\.activeThreadId, conversation\);/);
  assert.match(engine, /rememberTurn\(userId, ctx\.activeThreadId, lastSent\.place\(messages\), finalText, Date\.now\(\), lastSent\);/);
});

test('a task set for a moment a few minutes on starts from what the conversation last sent and read', () => {
  const { rememberTurn, lastRequest } = require('../lib/last-turn');
  const { carriedMessages } = require('../lib/task-evidence');
  const sent = [{ role: 'user', content: [{ type: 'text', text: 'Ask Dana and Ravi which day suits, and in four minutes see who has answered.' }] }];
  const system = [{ type: 'text', text: 'You are Closedhand.' }], tools = [{ name: 'search_cache', description: 's', input_schema: {} }];
  const t0 = Date.parse('2026-03-04T10:00:00Z');
  const conversation = [{ role: 'user', content: 'Ask Dana and Ravi which day suits, and in four minutes see who has answered.' }, { role: 'assistant', content: 'Asked both. I will look again at 10:04.' }];
  rememberTurn('u2', null, sent, 'Asked both. I will look again at 10:04.', t0, { system, tools });
  const chat = lastRequest('u2', null, conversation, t0 + 4 * 60000);
  assert.deepEqual([chat.system, chat.tools], [system, tools], 'the chat\'s own system prompt and tools, so the provider reads it from cache');
  assert.deepEqual(chat.messages, [...sent, conversation[1]]);
  const messages = carriedMessages({ ...chat, note: '[the moment has come: see who has answered]' });
  assert.equal(messages.at(-1).role, 'user');
  assert.equal(messages.at(-1).content.at(-1).text, '[the moment has come: see who has answered]', 'with what it is for as the one new thing');
  assert.equal(lastRequest('u2', null, conversation, t0 + 20 * 60000), null, 'one due much later starts plain, as before');
  rememberTurn('u3', null, sent, 'Asked both.', t0);
  assert.equal(lastRequest('u3', null, [{ role: 'assistant', content: 'Asked both.' }], t0 + 1000), null, 'nothing to start from without the request as it was sent');
  const scheduling = read('lib/scheduling.js');
  assert.match(scheduling, /require\("\.\/engine"\)\.lastRequest\(targetUserId, schedule\._threadId \|\| null, require\("\.\/conversation"\)\.getConversation\(targetUserId\)\)/);
  assert.match(scheduling, /startAgent\(targetUserId, deliverPlatform, targetChatId, schedule\.prompt, from \? \[String\(schedule\.name \|\| schedule\.prompt\)\.slice\(0, 200\)\] : null, from\);/);
  assert.match(read('lib/tools/handlers.js'), /_threadId: ctx\.activeThreadId \|\| null,/);
});
