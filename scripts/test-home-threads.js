// The web chat has Chat, one general conversation, and each project's own,
// picked in the sidebar or under the home page's box. A message carries on
// the one that is open; nothing is split into threads by hand.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('the home page box carries on Chat, or the project that is open; Main chat and the projects are picked under it', () => {
  const page = fs.readFileSync(path.join(root, 'webapp', 'views', 'index.html'), 'utf8');
  assert.doesNotMatch(page, /startFresh|\/api\/threads|startNewThread|switchToThread/, 'no new thread from the home page, and no threads to switch');
  assert.match(page, /if \(_openProject\) payload\.project = _openProject\.id;/, 'a message sent in a project is in it');
  assert.doesNotMatch(page, /heroContinuing|_homeContinue|Start fresh|drawEarlierMessages/, 'no "Continuing" line or quiet-hours carry-on');
  assert.doesNotMatch(page, /Pick up where you left off|hero-recent|hero-chip/, 'no drawer, pill or chips: the box carries on Chat');
  assert.match(page, /var chat = Number\(data\.chat\.message_count\) > 0;/, 'Main chat only once there is a conversation to go back to');
  assert.ok(page.includes(`'<span class="hero-projects-label">or pick up' + (chat ? '' : '<span class="hp-what"> a project</span>') + '</span>'`), 'the conversations, under the box');
  assert.match(page, /data-chat="1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"\/><\/svg>Main chat<\/button>/, 'Main chat first, by the Chat tab\'s own icon');
  assert.match(page, /var projects = \(data\.projects \|\| \[\]\)\.slice\(\)\.sort\(/, 'most recent first');
  assert.match(page, /openConversation\(b\.hasAttribute\('data-chat'\) \? null : b\.getAttribute\('data-conv'\)\);/, 'Main chat opens the conversation in full, as typing would, sending nothing');
  assert.match(page, /: _openProject && document\.body\.classList\.contains\('chat-active'\) \? 'Message ' \+ _openProject\.emoji \+ ' ' \+ _openProject\.name/, 'the box says which project it writes to');
  const conv = fs.readFileSync(path.join(root, 'lib', 'conversation.js'), 'utf8');
  assert.match(conv, /if \(!asked\.length && conversation\.filter\(m => m\.role === "user"\)\.length < 3\) return;/);
  const ws = fs.readFileSync(path.join(root, 'lib', 'web-chat-ws.js'), 'utf8');
  assert.match(ws, /const project = typeof msg\.project === "string" && \/\^\[0-9a-f-\]\{36\}\$\/i\.test\(msg\.project\) \? msg\.project : null;/);
});

test('on a phone the projects sit behind one "Projects" beside Main chat, which lists them along the bottom', () => {
  const page = fs.readFileSync(path.join(root, 'webapp', 'views', 'index.html'), 'utf8');
  assert.match(page, /\(projects\.length \? '<button type="button" class="hero-project hero-projects-open" id="heroProjectsOpen" aria-haspopup="menu" aria-expanded="false" aria-controls="projectsSheet"><svg [^']*<\/svg>Projects<\/button>' : ''\)/);
  // A desk names them in the row; a phone shows the one button.
  assert.match(page, /\n  \.hero-projects-open \{ display: none; \}\n  @media \(max-width: 600px\) \{/);
  assert.match(page, /#heroProjects \.hp-what, #heroProjects \.hero-project\[data-conv\], #heroProjects \.hero-project\[data-all\] \{ display: none; \}/);
  // Words and logos stand as they are under the box: no outline round Main chat, Projects or a chat app's logo.
  assert.doesNotMatch(page.slice(page.indexOf('  .hero-projects-open { display: none; }'), page.indexOf('@property --compose-sweep')), /border:/);
  assert.match(page, /\.continue-on \.send-via a\.via-icon, \.continue-on \.send-via a\.via-icon:hover \{[^}]*border: 0; border-radius: 50%; background: none;/);
  assert.match(page, /<div class="mon-context-menu projects-sheet" id="projectsSheet" role="menu" aria-label="Projects" hidden><\/div>/, 'the same menu the computer at the top opens');
  assert.match(page, /if \(b\.hasAttribute\('data-all'\)\) openDashSlide\('#projects'\); else openConversation\(b\.getAttribute\('data-conv'\)\);/, 'a name opens its conversation');
  // An iPhone sends no click for a tap on plain text, so a sheet closes on the touch itself.
  assert.match(page, /window\.closeOnOutside = function\(sheetId, openerId, close\) \{\n    document\.addEventListener\('pointerdown', function\(e\) \{/);
  assert.match(page, /window\.closeOnOutside\('projectsSheet', 'heroProjectsOpen', closeProjects\);/);
  assert.match(page, /window\.closeOnOutside\('deviceSheet', 'deviceToggle', closeDeviceSheet\);/);
  assert.ok(page.indexOf('window.closeOnOutside = function') < page.indexOf("window.closeOnOutside('projectsSheet'") && page.indexOf('window.closeOnOutside = function') < page.indexOf("window.closeOnOutside('deviceSheet'"), 'made before either sheet asks for it, however slowly the page arrives');
});

test('the count at the top says what is running', () => {
  const page = fs.readFileSync(path.join(root, 'webapp', 'views', 'index.html'), 'utf8');
  assert.match(page, /var tasks = data\.active \+ \(data\.active === 1 \? ' task' : ' tasks'\);\n\s+countEl\.innerHTML = tasks \+ '<span class="agents-working-more"> running<\/span>';/);
  assert.doesNotMatch(page, /<\/span> active\n/, '"1 active" did not say one what');
  assert.match(page, /<button type="button" class="agents-working" id="agentIndicator" hidden onclick="openDashSlide\('#agents'\)"><span class="agent-live-dot" aria-hidden="true"><\/span><span id="agentCount"><\/span><\/button>/, "the chat's own live dot, and it opens Agents");
  assert.match(page, /@media \(max-width: 389px\) \{ \.agents-working-more \{ display: none; \} \}/, 'the narrowest phones keep the fist');
});

test("a project's conversation, its card on the dashboard and its page lead to each other", () => {
  const fs = require("fs"), path = require("path");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const projects = read("webapp/public/projects.js");
  assert.match(projects, /const talk = way\("button", "chat", "Open conversation"\); talk\.type = "button";\n\s*talk\.onclick = \(\) => \{ window\.parent\.openConversation\(p\.id\); if \(window\.parent\.closeDashSlide\) window\.parent\.closeDashSlide\(\); \};/, "the card opens its conversation in the web chat");
  const pageJs = read("webapp/public/project-page.js");
  assert.match(pageJs, /inDashboard = !!window\.frameElement && window\.frameElement\.id === "dashIframe";/, "its page, opened from the card, does too");
  assert.match(pageJs, /talk\.onclick = \(\) => \{ chat\.openConversation\(id\); if \(chat\.closeDashSlide\) chat\.closeDashSlide\(\); \};/);
  assert.match(projects, /location\.hash\.match\(\/\^#projects\\\/\(\[0-9a-f-\]\{36\}\)\(\\\/edit\)\?\$\/i\)/, "and #projects/<id> opens the tab at that card, /edit its form");
  assert.match(read("webapp/views/dashboard.html"), /\} else if \(\/\^projects\\\/\[0-9a-f-\]\{36\}\(\\\/edit\)\?\$\/i\.test\(resolved\)\) \{\n\s+\/\/ One project[^\n]*\n[^\n]*\n\s+switchTab\('projects'\);/);
  const chat = read("webapp/views/index.html");
  assert.match(chat, /window\.openPage\('\/page\/project\/' \+ _openProject\.id, _openProject\.emoji \+ ' ' \+ _openProject\.name\)/, "the name above a project's conversation opens its page beside it, as any page from the chat opens");
  assert.match(chat, /name\.textContent = _openProject\.emoji \+ ' ' \+ _openProject\.name;/);
  assert.match(chat, /cue\.textContent = 'Open page';/);
  assert.doesNotMatch(chat, /\.conv-project-name \{[^}]*(ellipsis|nowrap)/, "a long name wraps, never cut");
  assert.match(chat, /window\.projectGone = function\(id\) \{\n\s*if \(_openProject && _openProject\.id === id\) \{ window\.closePage\(\); window\.openConversation\(null\); \}/, "a deleted project's open conversation gives way to Chat");
  assert.doesNotMatch(chat, /if \(projectId && !found && _conversations\) return;/, "a project made a moment ago still opens");
});
