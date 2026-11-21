// A sign-in page in the sandbox browser: the tool's own result tells the
// model to ask the person to sign in there, with the link, before anything else.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cfgPath = require.resolve('../lib/config');
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: { dashboardBase: async () => 'https://bright-river-12.closedhand.ai' } };
const vm = require('node:vm');
const { isSignInPage, signInNote, signInQuestion, signInAnswer, openForPerson, reopenedReply } = require('../lib/sign-in-wall');

test('sign-in pages are recognised, ordinary pages are not', () => {
  assert.equal(isSignInPage({ url: 'https://accounts.google.com/v3/signin/identifier?continue=https://www.google.com/maps/reserve/bookings', title: 'Sign in - Google Accounts' }), true);
  assert.equal(isSignInPage({ url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize' }), true);
  assert.equal(isSignInPage({ url: 'https://shop.example.com/account/login?next=/orders' }), true);
  assert.equal(isSignInPage({ url: 'https://example.com/', title: 'Log in to Example' }), true);
  assert.equal(isSignInPage({ url: 'https://www.google.com/maps/reserve/dine?m=x', title: 'Reserve with Google' }), false);
  assert.equal(isSignInPage({ url: 'https://blog.example.com/how-to-login-safely', title: 'Ten tips' }), false);
  assert.equal(isSignInPage({}), false);
});

test('the note asks the person to sign in, links where, and rules out the workarounds', async () => {
  const note = await signInNote({ url: 'https://accounts.google.com/v3/signin/identifier' });
  assert.match(note, /accounts\.google\.com/);
  assert.match(note, /https:\/\/bright-river-12\.closedhand\.ai\/#computers/);
  assert.match(note, /Offer this before any other way round it/);
  assert.match(note, /Never type their details, and never look for another way past the sign-in/);
});

test('the browser tool attaches the note on both of its return paths, and says so up front', () => {
  const handlers = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'handlers.js'), 'utf8');
  assert.equal((handlers.match(/await signInFound\(/g) || []).length, 2);
  assert.match(handlers, /const opened = engine === "headless" \? await wall\.openForPerson\(userId, page\.url\) : true;\n\s+return \{ sign_in_needed: await wall\.signInNote\(page, \{ opened \}\), sign_in_site: wall\.siteOf\(page\.url\), sign_in_url: page\.url, sign_in_opened: opened \};/, "the page waits in the visible browser, where the person signs in, and is said to be there only when it is");
  const defs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'definitions.js'), 'utf8');
  assert.match(defs, /A page that asks to sign in means the person signs in there themselves, once, on the Computers tab of the web chat/);
  const agents = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agents.js'), 'utf8');
  assert.match(agents, /the job stops and asks them to, as the first way forward, and you carry on once they have/);
});

test('a job stopped on a sign-in page asks with the link, and understands done, no and not yet', async () => {
  const q = await signInQuestion('shop.example.com');
  assert.match(q, /^shop\.example\.com needs you signed in before I can carry on\. Sign in on Closedhand's sandbox computer: https:\/\/bright-river-12\.closedhand\.ai\/#computers\./);
  assert.match(q, /Reply done when you have, and I'll pick up where I left off\.$/);
  for (const t of ['done', 'Done!', 'signed in', "I've logged in now", 'ok']) assert.equal(signInAnswer(t), 'done', t);
  for (const t of ['no', 'skip it', "I can't", 'not now']) assert.equal(signInAnswer(t), 'no', t);
  for (const t of ['not yet', 'one sec', 'hold on, still signing in']) assert.equal(signInAnswer(t), 'wait', t);
  for (const t of ['what time is it in Testford?', 'thanks']) assert.equal(signInAnswer(t), null, t);
  // A longer reply that says it plainly carries the job on, and one that says otherwise does not.
  for (const t of ["I'm signed in on it. Do i need to stay on the screen while you do it?", "I've logged in now, carry on and tell me when it's sent please", "ok I am now signed in, the code came through on my phone"]) assert.equal(signInAnswer(t), 'done', t);
  for (const t of ["I haven't signed in yet, I'll do it later tonight when I'm home", "I can't sign in, it keeps asking for a code I don't have", "what does it want me to sign in to exactly, the Google account or the other one?"]) assert.equal(signInAnswer(t), null, t);
});

function loadConfirmation(pendings, wall = require('../lib/sign-in-wall')) {
  const conversation = [], resumed = [], ctx = { pendingConfirmations: pendings };
  const stub = new Proxy({}, { get: () => () => {} });
  const deps = {
    './context': ctx, './storage': { saveStore() {} }, './conversation': { getConversation: () => conversation },
    './tools/handlers': stub, './mcp': stub, './spend-guard': { ledgerUpdate: async () => {} }, './messaging': { sendTyping() {} },
    './confirmation-lifetime': require('../lib/confirmation-lifetime'), './sign-in-wall': wall,
    './agents': { resumeAgentAfterConfirmation: async (p, approved) => { resumed.push(approved); return approved ? 'Thanks, carrying on.' : "OK, I'll carry on without it."; } },
  };
  const context = { module: { exports: {} }, console, Date, require: (name) => { if (!(name in deps)) throw Error(name); return deps[name]; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'confirmation.js'), 'utf8'), context);
  return { ...context.module.exports, ctx, conversation, resumed };
}

test('a reply to the sign-in question carries the job on, keeps it waiting, or is a new message', async () => {
  const waiting = () => ({ u1: { isAgent: true, kind: 'sign_in', site: 'shop.example.com', taskId: 't1', pausedAt: Date.now() } });
  let c = loadConfirmation(waiting());
  assert.equal(await c.handleConfirmation('u1', 'chat', 'not yet'), "OK, I'll wait. Reply done when you've signed in.");
  assert.ok(c.ctx.pendingConfirmations.u1, 'still waiting');
  assert.equal(await c.handleConfirmation('u1', 'chat', 'signed in'), 'Thanks, carrying on.');
  assert.deepEqual(c.resumed, [true]);
  assert.equal(c.ctx.pendingConfirmations.u1, undefined);
  assert.equal(c.conversation.at(-2).content, 'signed in', "the person's own words are kept");
  c = loadConfirmation(waiting());
  assert.equal(await c.handleConfirmation('u1', 'chat', 'skip it'), "OK, I'll carry on without it.");
  assert.deepEqual(c.resumed, [false]);
  c = loadConfirmation(waiting());
  assert.equal(await c.handleConfirmation('u1', 'chat', 'what time is it in Testford?'), false, 'anything else is a new message');
});

// The agent once read "today" off the server's clock (UTC) while the person's
// day had already turned, and called the booking page's correct "Today" a trap.
test('every prompt that tells a model the date uses the person\'s own clock', () => {
  const lib = path.join(__dirname, '..', 'lib');
  const files = fs.readdirSync(lib).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(lib, f), 'utf8')]);
  for (const [f, src] of files) {
    assert.doesNotMatch(src, /Today is \$\{new Date\(/, f);
    assert.doesNotMatch(src, /Today is \$\{today\}/, f);
  }
  for (const f of ['agents.js', 'projects.js', 'onboarding.js']) {
    assert.match(fs.readFileSync(path.join(lib, f), 'utf8'), /currentTimeContext\(/, f);
  }
});

// A job told the person "it's open on the page" when the visible browser had
// not opened it; they looked, saw nothing, said so, and the job was dropped
// as if they had moved on.
test('the page is said to be open only when the visible browser says it is', async () => {
  const asked = [];
  const browse = (answer) => async (body) => { asked.push(body); if (answer instanceof Error) throw answer; return answer; };
  assert.equal(await openForPerson('u1', 'https://delays.example.co.uk/login', browse({ result: { url: 'https://delays.example.co.uk/login', title: 'Sign in' } })), true);
  assert.deepEqual(asked[0], { op: 'step', engine: 'visible', step: { action: 'goto', url: 'https://delays.example.co.uk/login' } });
  assert.equal(await openForPerson('u1', 'https://delays.example.co.uk/login', browse({ error: 'timed out' })), false);
  assert.equal(await openForPerson('u1', 'https://delays.example.co.uk/login', browse({ result: { error: 'net::ERR_NAME_NOT_RESOLVED' } })), false);
  assert.equal(await openForPerson('u1', 'https://delays.example.co.uk/login', browse(new Error('sandbox asleep'))), false);
  assert.equal(await openForPerson('u1', null, browse({ result: {} })), false, 'no address, nothing opened');
  assert.equal(asked.length, 4);

  const shut = await signInNote({ url: 'https://delays.example.co.uk/login' }, { opened: false });
  assert.match(shut, /The page could not be opened there, so give them its address to open in that browser first: https:\/\/delays\.example\.co\.uk\/login/);
  assert.match(await signInNote({ url: 'https://delays.example.co.uk/login' }), /The page is open there now\./);
  const q = await signInQuestion('delays.example.co.uk', { url: 'https://delays.example.co.uk/login', opened: false });
  assert.match(q, /I couldn't open the page there myself, so open https:\/\/delays\.example\.co\.uk\/login in that browser first, and it stays signed in for next time\./);
  assert.doesNotMatch(q, /It's open on the page/);
  assert.match(await signInQuestion('delays.example.co.uk'), /It's open on the page, and it stays signed in/);
});

test('"it isn\'t open" is understood: the page is opened again and the job goes on waiting', async () => {
  for (const t of ["it doesn't have it open", "you don't have the delays page open", "there's no delays page", "It's not open", "I can't see it", "the sandbox browser is blank", "it's on a different page", "there is no page open on it, it is on the help page"]) assert.equal(signInAnswer(t), 'missing', t);
  for (const t of ["I don't have an account", "I don't have time for this now, do the other one instead please"]) assert.notEqual(signInAnswer(t), 'missing', t);
  assert.match(await reopenedReply(true, 'https://delays.example.co.uk/login'), /^Sorry, it wasn't there\. It's open now on the Computers tab \(https:\/\/bright-river-12\.closedhand\.ai\/#computers\)\. Reply done once you've signed in\.$/);
  assert.match(await reopenedReply(false, 'https://delays.example.co.uk/login'), /^I couldn't open it there myself\. Open https:\/\/delays\.example\.co\.uk\/login in the browser on the Computers tab/);

  const opened = [];
  const wall = { ...require('../lib/sign-in-wall'), openForPerson: async (userId, url) => { opened.push(url); return true; } };
  const c = loadConfirmation({ u1: { isAgent: true, kind: 'sign_in', site: 'delays.example.co.uk', url: 'https://delays.example.co.uk/login', taskId: 't1', pausedAt: Date.now() } }, wall);
  assert.match(await c.handleConfirmation('u1', 'chat', "it doesn't have it open"), /^Sorry, it wasn't there\. It's open now/);
  assert.deepEqual(opened, ['https://delays.example.co.uk/login'], 'the page it stopped on');
  assert.ok(c.ctx.pendingConfirmations.u1, 'still waiting for the sign-in, never dropped');
  assert.deepEqual(c.resumed, []);
  assert.equal(await c.handleConfirmation('u1', 'chat', 'done'), 'Thanks, carrying on.');
  const older = loadConfirmation({ u1: { isAgent: true, kind: 'sign_in', site: 'delays.example.co.uk', taskId: 't1', pausedAt: Date.now() } }, wall);
  await older.handleConfirmation('u1', 'chat', "I can't see it");
  assert.equal(opened.at(-1), 'https://delays.example.co.uk', 'a question asked before the address was kept opens the site');
  const agents = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agents.js'), 'utf8');
  assert.match(agents, /signInWait = \{ site: result\.sign_in_site \|\| "", url: result\.sign_in_url \|\| null, opened: result\.sign_in_opened !== false \};/);
  assert.match(agents, /signInQuestion\(signInWait\.site, signInWait\)/);
  assert.match(agents, /kind: "sign_in", site: signInWait\.site, url: signInWait\.url,/);
});
