// A sign-in to Google or another service started away from the computer
// running Closedhand (a phone, through the personal URL) used to come back to
// localhost and end on a dead page after the person had agreed. Now it comes
// back to the personal URL once the app allows that address, and otherwise
// says to finish on the computer before anyone signs in. Links the bot sends
// in chat apps point at the personal URL, not this computer's own address.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const server = read("webapp/server.js");
const start = server.slice(server.indexOf('app.get("/auth/:service", async'), server.indexOf('// Build state'));

test("started away from this computer, a sign-in that can only come back here stops first", () => {
  assert.match(start, /if \(fromElsewhere\(req\) && require\("\.\/google-app"\)\.canReturnTo\(BASE_URL\)\) \{/);
  assert.match(start, /const anywhere = personal && !closedhandApp \?/, "Closedhand's own Google app returns only to the computer that asked");
  assert.match(start, /else return sendFinishHere\(res,/);
  assert.ok(start.indexOf("closedhandApp = true;") > 0);
});

test("the address it came back to is the one the code is exchanged at, and the app is remembered", () => {
  assert.match(server, /const stateData = \{\n\s*service: serviceKey,\n\s*redirectUri,/);
  const callback = server.slice(server.indexOf('app.get("/auth/:service/callback"'), server.indexOf("// Exchange auth code for tokens"));
  assert.match(callback, /const redirectUri = stateData\.redirectUri \|\| `\$\{BASE_URL\}\/auth\/\$\{serviceKey\}\/callback`;/);
  assert.match(callback, /setRuntimeConf\(\{ \[returnsAnywhereKey\(serviceKey\)\]: "1" \}\)/);
});

test("the page says where to finish, escapes what it shows, and offers the address only for an app of the person's own", () => {
  const src = server.slice(server.indexOf("const returnsAnywhereKey ="), server.indexOf('app.get("/auth/:service", async'));
  const sent = [];
  const res = { set() { return res; }, type() { return res; }, send(html) { sent.push(html); return res; } };
  const assets = { stamp: (h) => h, withAppearance: (h) => h };
  const { sendFinishHere, returnsAnywhereKey } = new Function("assets", "path", "require", "__dirname", src + "; return { sendFinishHere, returnsAnywhereKey };")(assets, path, require, path.join(__dirname, "..", "webapp"));
  assert.equal(returnsAnywhereKey("google"), "SIGN_IN_RETURNS_ANYWHERE_GOOGLE");
  sendFinishHere(res, { name: "Google<script>", anywhere: "https://quiet-test.closedhand.com/auth/google/callback", again: "/auth/google?extra=1" });
  assert.doesNotMatch(sent[0], /<script>alert|Google<script>/);
  assert.match(sent[0], /Google&lt;script&gt; hands this sign-in back only to that computer/);
  assert.match(sent[0], /<code id="addr">https:\/\/quiet-test\.closedhand\.com\/auth\/google\/callback<\/code>/);
  assert.match(sent[0], /href="\/auth\/google\?extra=1&amp;anywhere=1"/);
  assert.match(sent[0], /<div class="card">/);
  sendFinishHere(res, { name: "Google", anywhere: null, again: "/auth/google" });
  assert.match(sent[1], /<div class="card only-here">/, "nothing to add for Closedhand's own app");
});

test("links the bot sends stay on the web chat's address there, and use the personal URL in chat apps", async () => {
  const config = require("../lib/config");
  const saved = config.dashboardBase;
  config.dashboardBase = async () => "https://quiet-test.closedhand.com";
  delete require.cache[require.resolve("../lib/dashboard-links")];
  try {
    const { closedhandLink } = require("../lib/dashboard-links");
    assert.equal(await closedhandLink("web", "/auth/notion"), "/auth/notion");
    assert.equal(await closedhandLink("whatsapp", "/auth/google"), "https://quiet-test.closedhand.com/auth/google");
  } finally {
    config.dashboardBase = saved;
    delete require.cache[require.resolve("../lib/dashboard-links")];
  }
  const handlers = read("lib/tools/handlers.js");
  // Connecting a service from chat goes to the one place connections are
  // added, the dashboard's Connections tab. It went through /bot-connect, a
  // link signed with a key from the hosted days that no setup has, so making
  // it threw every time; then to the service's own sign-in address, which
  // opened on an error wherever no app was set up for the service: everywhere.
  const { CONNECTABLE_SERVICES, serverFor } = require("../lib/services-config");
  let servers = [];
  const tool = (name, upTo) => require("node:vm").runInNewContext(
    `(async (toolInput, ctx) => { switch (${JSON.stringify(name)}) { ${handlers.slice(handlers.indexOf(`case "${name}": {`), handlers.indexOf(`case "${upTo}": {`))} } })`,
    { CONNECTABLE_SERVICES, serverFor,
      require: (id) => (id === "../dashboard-links" ? { dashboardUrl: async (platform, tab) => (platform === "web" ? "" : "https://quiet-test.closedhand.com") + `/dashboard#${tab}` }
        : id === "../user-mcp" ? { connectedServers: () => servers }
        : id === "../api-connections" ? { list: () => [{ name: "Kestrel Voice" }] } : require(id)) });
  const connect = tool("connect_service", "wait_for_result"), list = tool("list_connections", "connect_service");
  // A service with a tile is pressed there; a bank has its form; anything
  // else, by whatever name the person gave, goes into the box.
  for (const [service, says] of [["slack", /presses Slack there and follows what it asks/], ["shopify", /presses Shopify there/], ["microsoft", /presses Microsoft 365 there/],
    ["simplefin", /signs up to the bank service/], ["hubspot", /hubspot has no tile of its own there, so the person pastes its MCP server address or an API key/], ["Harbour_CRM", /Harbour CRM has no tile of its own there/]]) {
    const result = await connect({ service }, { activePlatform: "whatsapp" });
    assert.equal(result.url, "https://quiet-test.closedhand.com/dashboard#connections", service);
    assert.match(result.message, says, service);
    assert.doesNotMatch(JSON.stringify(result), /\/auth\//, service);
  }
  // The chat the ask came from decides the link, also where a task or a
  // reminder runs the tool and only the call itself says which chat that is.
  assert.equal((await connect({ service: "slack", _platform: "telegram" }, {})).url, "https://quiet-test.closedhand.com/dashboard#connections");
  assert.equal((await connect({ service: "slack" }, {})).url, "/dashboard#connections");
  assert.match((await connect({ service: "imap" }, {})).error, /can't be added yet/);

  // A service connected through its company's MCP server is connected: the
  // chat says so, and does not offer to connect it again.
  assert.ok((await list({}, {})).available.some((a) => a.service === "slack"));
  servers = [{ name: "Slack", host: "mcp.slack.com" }, { name: "Harbour Notes", host: "notes.harbour.example" }];
  const listed = await list({}, {});
  assert.deepEqual(Array.from(listed.connected, (c) => c.name), ["Slack", "Harbour Notes", "Kestrel Voice"], "known services, any other server, and anything connected with a key");
  assert.equal(listed.available.some((a) => a.service === "slack"), false);
  assert.match((await connect({ service: "slack" }, {})).error, /Slack is already connected/);
  // The hosts are the catalogue's: every service whose tile is an MCP server.
  const { remote } = require("../webapp/connection-catalogue");
  assert.deepEqual(Object.fromEntries(Object.entries(CONNECTABLE_SERVICES).filter(([, svc]) => svc.mcp).map(([key, svc]) => [key, svc.mcp]).sort()),
    Object.fromEntries(Object.entries(remote).map(([key, url]) => [key, new URL(url).hostname]).sort()));
  for (const f of ["lib/tools/handlers.js", "lib/services-config.js", "webapp/server.js"]) {
    assert.doesNotMatch(read(f), /bot-connect/, f);
    assert.doesNotMatch(read(f), /createHmac\("sha256", process\.env\.SUPABASE_SERVICE_KEY\)/, f);
  }
  assert.match(handlers, /closedhandLink\(ctx\.activePlatform \|\| "web", `\/auth\/\$\{service\}`\)/);
});
