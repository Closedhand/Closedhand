// The sandbox computer has two browsers, both signed in with the person's
// logins: the hidden one (no window: faster, several pages at once, out of
// the way) and the visible one on the Computers tab. Closedhand picks per
// job (lib/browse-engine.js); sites that watch for automation always run
// visible; a site that answers the hidden browser with a check for bots
// moves to the visible one, where a read is done again and an action is
// not; a check that wants a person is handed to the person. Measured on the
// sandbox image: five pages read at once in 3.6 s against 12.5 s one after
// another.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const engines = require("../lib/browse-engine");

const CHECK = { status: 200, url: "https://shop.example.com/", html: "<title>Just a moment...</title>", text: "Checking your browser before accessing the site." };
const FINE = { status: 200, url: "https://shop.example.com/", html: "<title>Shop</title>", text: "A long ordinary page ".repeat(100) };

test("the job decides, sites that watch for automation always run visible, and a follow-up stays put", () => {
  engines._reset();
  assert.equal(engines.choose("u", { action: "outline", url: "https://www.instagram.com/p/AbC/" }), "visible");
  assert.equal(engines.choose("u", { action: "click", url: "https://m.facebook.com/", browser: "headless" }), "visible", "even when asked for the hidden one");
  assert.equal(engines.choose("u", { action: "read_pages", urls: ["https://news.example.com/a"] }), "headless");
  assert.equal(engines.choose("u", { action: "outline", url: "https://tickets.example.com/", browser: "visible" }), "visible", "the person may need to step in");
  engines.ran("u", "visible", "https://tickets.example.com/basket");
  assert.equal(engines.choose("u", { action: "click", ref: 4 }), "visible", "a follow-up stays in the browser the job is in");
  assert.equal(engines.choose("u", { action: "fill_card" }), "visible", "the card goes where the checkout is");
  assert.equal(engines.choose("u", { action: "fill_address" }), "visible", "so does the address");
  assert.equal(engines.carryOver("u", "headless"), "https://tickets.example.com/basket", "a switch picks up on the page the job was on");
  assert.equal(engines.carryOver("u", "visible"), null);
});

test("a check for bots moves the site to the visible browser for the day", () => {
  engines._reset();
  assert.equal(engines.wasStopped(CHECK), true);
  assert.equal(engines.wasStopped({ ...FINE, status: 403 }), true);
  assert.equal(engines.wasStopped(FINE), false);
  engines.moveToVisible("u", "shop.example.com");
  assert.equal(engines.choose("u", { action: "outline", url: "https://shop.example.com/sale" }), "visible");
  assert.equal(engines.choose("other", { action: "outline", url: "https://shop.example.com/sale" }), "headless", "for that person only");
});

test("pages read together in the hidden browser; a stopped one is read again visibly, and one that wants a person says so", async () => {
  engines._reset();
  const calls = [];
  const browse = async (body) => {
    calls.push(body);
    if (body.op === "read_pages") return { result: { pages: body.urls.map((u) => (u.includes("shop") ? { asked: u, url: u, title: "Just a moment...", text: "", probe: CHECK } : { asked: u, url: u, title: "News", text: "story", probe: FINE })) } };
    if (body.step.url.includes("shop")) return { result: { url: body.step.url, title: "Shop", text: "prices", probe: FINE } };
    return { result: { url: body.step.url, title: "Instagram", text: "", probe: { ...CHECK, url: body.step.url } } };
  };
  const out = await engines.readPages("u", ["https://news.example.com/a", "https://shop.example.com/", "https://www.instagram.com/someone/"], browse);
  assert.deepEqual(calls.map((c) => `${c.op}:${c.engine}`), ["read_pages:headless", "step:visible", "step:visible"]);
  assert.deepEqual(calls[0].urls, ["https://news.example.com/a", "https://shop.example.com/"], "Instagram never goes to the hidden browser");
  assert.equal(out.pages[0].text, "story");
  assert.equal(out.pages[0].probe, undefined, "the probe stays between the bot and the browser");
  assert.equal(out.pages[1].read_in, "visible");
  assert.equal(out.pages[1].text, "prices");
  assert.match(out.pages[2].needs_person, /www\.instagram\.com wants a person to show they are human\. Ask the person to open the Computers tab/);
  assert.equal(engines.choose("u", { action: "outline", url: "https://shop.example.com/x" }), "visible", "and the shop stays visible");
});

test("the tool flips a read by itself, never an action, and keeps the probe to itself", () => {
  const handlers = read("lib/tools/handlers.js");
  const browse = handlers.slice(handlers.indexOf('case "sandbox_browse": {'), handlers.indexOf("// --- Background Agents ---"));
  assert.match(browse, /const engine = engines\.choose\(userId, toolInput\);/);
  assert.match(browse, /if \(engine === "headless" && engines\.wasStopped\(parsed\.probe\)\) \{/);
  assert.match(browse, /if \(!onlyReads\) \{[\s\S]{0,200}so nothing was done there\. It runs in the visible browser from now on: do the step again\./);
  assert.match(browse, /answer = await sandboxBrowse\(userId, \{ \.\.\.again, engine: "visible" \}, 60000\);/);
  assert.match(browse, /delete parsed\.probe;/);
  assert.match(browse, /wallet\.fillScript\(secret, require\("\.\.\/browse-engine"\)\.choose\(userId, \{ action: "fill_card" \}\), billing\)/);
  assert.match(browse, /wallet\.addressScript\(address, require\("\.\.\/browse-engine"\)\.choose\(userId, \{ action: "fill_address" \}\)\)/);
  // web_fetch hands what plain fetching cannot read to the browsers.
  assert.match(handlers, /if \(require\("\.\.\/blocked-page"\)\.looksBlocked\(body\)\) \{\n\s*return \(await inBrowser\(\)\) \|\|/);
  assert.match(handlers, /if \(page\.text\.length < 300 && \/<script\/i\.test\(body\)\) \{/);
  // The checkout is read in the browser the paying step runs in.
  assert.match(read("lib/spend-guard.js"), /const engine = require\("\.\/browse-engine"\)\.choose\(userId, \{ \.\.\.input, url: url \|\| input\.url \}\);/);
  for (const f of ["lib/engine.js", "lib/agents.js", "lib/automations.js", "lib/scheduling.js"]) assert.match(read(f), /spendGuard\.readCheckout\(userId, \w+\.at, block\.input\)/, f);
});

test("the sandbox starts the hidden browser on demand, looking like the visible one, and copies logins both ways", () => {
  const server = read("sandbox-image/agent/server.js");
  assert.match(server, /if \(engine === "headless"\) await ensureHeadless\(\);/);
  assert.match(server, /visible\["User-Agent"\]\.replace\(\/HeadlessChrome\/g, "Chrome"\)/, "sites are told the same browser, not HeadlessChrome");
  assert.match(server, /Date\.now\(\) - lastHeadlessAt > HEADLESS_IDLE_MS\) \{ stopHeadless\(\);/, "it goes after ten quiet minutes");
  const helper = read("sandbox-image/agent/browser_helper.py");
  assert.match(helper, /def _sync_in\(hidden\):[\s\S]*?hidden\.clear_cookies\(\)/, "a sign-out in the visible browser is a sign-out in the hidden one");
  assert.match(helper, /def _sync_out\(hidden, hosts\):[\s\S]*?_get_browser\("visible"\)\[2\]\.add_cookies\(fresh\)/, "a renewed session goes back");
  assert.match(helper, /cdp\.send\("Network\.setBlockedURLs", \{"urls": _SKIP_WHEN_READING\}\)/, "images are dropped inside Chrome, not queued through Python");
  assert.match(read("lib/wallet.js"), /pw, browser, context = _get_browser\(\$\{JSON\.stringify\(engine === "headless" \? "headless" : "visible"\)\}\)/);
});

// A reply to a refund claim was typed in the hidden browser; the person, told
// it was about to be sent, looked at the visible one and saw an empty box.
test("typing, clicking and pressing keys are done in the visible browser, where the person can watch", () => {
  engines._reset();
  assert.equal(engines.acts({ action: "fill", ref: 3, text: "Hello" }), true);
  assert.equal(engines.acts({ action: "click", ref: 3 }), true);
  assert.equal(engines.acts({ action: "press", key: "Enter" }), true);
  assert.equal(engines.acts({ action: "batch", steps: [{ action: "outline" }, { action: "fill", ref: 2, text: "x" }] }), true);
  for (const action of ["outline", "scrape_text", "screenshot", "extract_data", "read_pages", "wait_for"]) assert.equal(engines.acts({ action }), false, action);
  assert.equal(engines.acts({ action: "batch", steps: [{ action: "outline" }, { action: "scrape_text" }] }), false);

  engines.ran("u", "headless", "https://help.example.com/contact/message/42");
  assert.deepEqual(engines.actsHidden("u", { action: "fill", ref: 7, text: "Hello" }, "headless"), { host: "help.example.com", url: "https://help.example.com/contact/message/42" }, "the page the job was reading");
  assert.deepEqual(engines.actsHidden("u", { action: "click", ref: 1, url: "https://shop.example.com/basket" }, "headless"), { host: "shop.example.com", url: "https://shop.example.com/basket" });
  assert.equal(engines.actsHidden("u", { action: "fill", ref: 7, text: "x" }, "visible"), null, "already where they can watch");
  assert.equal(engines.actsHidden("u", { action: "outline" }, "headless"), null, "reading stays hidden");
  engines.moveToVisible("u", "help.example.com");
  assert.equal(engines.choose("u", { action: "outline", url: "https://help.example.com/contact" }), "visible", "and the site stays visible for the day");

  const handlers = read("lib/tools/handlers.js");
  const at = handlers.indexOf("const moving = engines.actsHidden(");
  assert.ok(at > handlers.indexOf("const engine = engines.choose(userId, toolInput);"), "decided once the browser is chosen");
  assert.ok(at < handlers.indexOf("let answer = await sandboxBrowse(userId, { ...body, engine }, 60000);"), "and before anything is done");
  const block = handlers.slice(at, handlers.indexOf("// A step in the other browser than the last one", at));
  assert.match(block, /engines\.moveToVisible\(userId, moving\.host\);/);
  assert.match(block, /sandboxBrowse\(userId, \{ op: "step", engine: "visible", step: \{ action: "outline", url: moving\.url \} \}, 60000\)/, "the page is opened there and read again: an outline's numbers belong to the browser that made it");
  assert.match(block, /moved_to_visible: `Nothing was done yet\./);
  assert.doesNotMatch(block, /\{ \.\.\.body, engine \}/, "the step itself is not run");
});
