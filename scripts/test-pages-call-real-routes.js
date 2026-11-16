// The web chat asked the server for /api/teams every eight seconds, and the
// dashboard's "Connect" button posted to /api/generate-code: neither route
// exists. A page that calls a route the server lacks fails where nobody sees
// it, so every /api path a page names must be one the server answers.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

function routes() {
  const found = [];
  for (const f of fs.readdirSync(path.join(root, "webapp")).filter((n) => n.endsWith(".js"))) {
    const src = read("webapp/" + f);
    for (const m of src.matchAll(/\b(?:app|router|r)\.(?:get|post|put|patch|delete|all|use)\(\s*(["'`])([^"'`]+)\1/g)) found.push(m[2]);
    for (const m of src.matchAll(/\b(?:app|router|r)\.(?:get|post|put|patch|delete|all|use)\(\s*\[([^\]]+)\]/g)) {
      for (const p of m[1].matchAll(/["'`]([^"'`]+)["'`]/g)) found.push(p[1]);
    }
  }
  return found;
}
const asPattern = (route) => new RegExp("^" + route.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z_]+\??/g, "[^/]+").replace(/\*/g, ".*") + "/?$");

function pages() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const p = dir + "/" + e.name;
      if (e.isDirectory()) { if (!/^(novnc|vendor|art|models)$/.test(e.name)) walk(p); } else if (/\.(html|js)$/.test(e.name)) out.push(p);
    }
  };
  walk("webapp/views"); walk("webapp/public");
  return out;
}

// Each "/api/..." a page names: whole when the text ends there (or goes on to
// a query), a beginning when more is joined on.
function named(src) {
  const out = [];
  for (const m of src.matchAll(/(["'`])(\/api\/[A-Za-z0-9_\-/.:]*)(\1|\?|\$\{)?/g)) {
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 3);
    const whole = (m[3] === m[1] && !/^\s*\+/.test(after)) || m[3] === "?";
    out.push({ path: m[2], whole, line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

test("every /api path the app's pages name is a route the server has", () => {
  const all = routes();
  assert.ok(all.length > 200, "the routes were found");
  const whole = all.map(asPattern);
  const missing = [];
  let seen = 0;
  for (const f of pages()) {
    for (const n of named(read(f))) {
      seen++;
      const stem = n.path.replace(/\/$/, "");
      const ok = n.whole
        ? whole.some((re) => re.test(n.path))
        : all.some((r) => r.startsWith(n.path) || asPattern(r.split("/").slice(0, stem.split("/").length).join("/")).test(stem));
      if (!ok) missing.push(`${f}:${n.line} ${n.path}`);
    }
  }
  assert.ok(seen > 150, "the pages' paths were found");
  assert.deepEqual(missing, [], "paths with no route");
});

test("the check catches a path with no route, whole or joined", () => {
  const all = ["/api/agents", "/api/agents/:id/stop"];
  const whole = all.map(asPattern);
  const judge = (src) => named(src).map((n) => {
    const stem = n.path.replace(/\/$/, "");
    return n.whole ? whole.some((re) => re.test(n.path))
      : all.some((r) => r.startsWith(n.path) || asPattern(r.split("/").slice(0, stem.split("/").length).join("/")).test(stem));
  });
  assert.deepEqual(judge("fetch('/api/agents')"), [true]);
  assert.deepEqual(judge("fetch('/api/agents?all=1')"), [true]);
  assert.deepEqual(judge("fetch('/api/agents/' + id + '/stop')"), [true]);
  assert.deepEqual(judge("fetch('/api/teams')"), [false]);
  assert.deepEqual(judge("fetch('/api/teams/' + id)"), [false]);
});

// The dashboard is a frame over the web chat that stays loaded when its panel
// is closed. Its timers went on asking the server every few seconds with
// nobody reading the answer, and File Search asked every three seconds for
// ever once anything had been indexing.
test("nothing asks the server on a timer while nobody is looking", () => {
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /function dashShowing\(\) \{\s+if \(document\.hidden\) return false;[\s\S]{0,300}classList\.contains\('active'\) \|\| panel\.classList\.contains\('account'\)/);
  assert.match(dash, /setInterval\(function \(\) \{ if \(dashShowing\(\)\) refreshTab\(_polledTab\); \}/);
  assert.match(dash, /setInterval\(function\(\) \{ if \(dashShowing\(\)\) loadBridgeStatus\(\); \}, 15000\)/);
  assert.match(dash, /setInterval\(function \(\) \{ if \(typeof dashShowing !== 'function' \|\| dashShowing\(\)\) tick\(\); \}, 6000\)/);
  assert.match(dash, /e\.data\.type === 'dash-shown'[\s\S]{0,120}refreshTab\(_polledTab\)/, "and it catches up the moment the panel opens again");
  const chat = read("webapp/views/index.html");
  assert.match(chat, /overlay\.classList\.add\('active'\);\s+try \{ iframe\.contentWindow\.postMessage\(\{ type: 'dash-shown' \}/);
  assert.match(chat, /if \(hasIndexing\) ragStartPolling\(\); else ragStopPolling\(\);/, "File Search stops asking once nothing is being read");
  assert.match(chat, /function pollAgentStatus\(\) \{\s+if \(!isAuthenticated \|\| document\.hidden\) return;/);
  assert.match(chat, /setInterval\(function\(\)\{ if \(!document\.hidden\) checkBridgeStatus\(\); \}, 15000\)/);
});
