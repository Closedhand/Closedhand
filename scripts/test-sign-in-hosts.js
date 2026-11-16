// A connected service's sign-in goes only to that service's own addresses,
// however the model was talked into asking for another one.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { signInMayGo, refusal } = require("../lib/sign-in-hosts");

test("each sign-in goes to its own service's API addresses", () => {
  for (const [service, url] of [
    ["google", "https://gmail.googleapis.com/gmail/v1/users/me/messages"],
    ["google", "https://www.googleapis.com/drive/v3/files"],
    ["hubspot", "https://api.hubapi.com/crm/v3/objects/contacts"],
    ["spotify", "https://api.spotify.com/v1/me/playlists"],
    ["salesforce", "https://kestrel-co.my.salesforce.com/services/data/v59.0/query"],
    ["microsoft", "https://graph.microsoft.com/v1.0/me"],
  ]) assert.equal(signInMayGo(service, url), true, `${service} ${url}`);
});

test("and to nowhere else", () => {
  for (const [service, url] of [
    ["google", "https://collect.kestrel.example/?q=1"],
    ["google", "https://googleapis.com.kestrel.example/x"],
    ["google", "https://evilgoogleapis.com/x"],
    ["google", "http://www.googleapis.com/drive/v3/files"],
    ["hubspot", "https://api.hubapi.com.kestrel.example/crm"],
    ["hubspot", "https://user:pw@api.hubapi.com/crm"],
    ["spotify", "https://hooks.kestrel.example/spotify"],
    // A service that connects through its own MCP server has no sign-in here.
    ["slack", "https://slack.com/api/conversations.list"],
    ["github", "https://api.github.com/user/repos"],
    ["whatsapp", "https://graph.facebook.com.kestrel.example/"],
    ["salesforce", "https://salesforce.kestrel.example/"],
    ["lunchflow", "https://anything.example/"],
    ["kestrel", "https://api.kestrel.example/"],
    ["hubspot", "not an address"],
  ]) assert.equal(signInMayGo(service, url), false, `${service} ${url}`);
});

test("the same rule holds for a service whose code builds the address itself", () => {
  assert.equal(signInMayGo("shopify", "https://kestrel-goods.myshopify.com/admin/api/2026-01/orders.json"), true);
  assert.equal(signInMayGo("shopify", "https://kestrel.example/admin/api/2026-01/orders.json"), false);
});

test("the model is told where the sign-in goes, so it can correct the call", () => {
  assert.equal(refusal("google"), 'The google sign-in is only ever sent to *.googleapis.com, over https. For any other address, use service "none".');
  assert.match(refusal("kestrel"), /no sign-in for "kestrel"/);
});

test("both tools that send a sign-in check before anything is sent", () => {
  const src = fs.readFileSync(path.join(__dirname, "../lib/tools/handlers.js"), "utf8");
  for (const tool of ["api_request", "sandbox_gateway"]) {
    const body = src.slice(src.indexOf(`case "${tool}": {`));
    const check = body.indexOf('require("../sign-in-hosts").signInMayGo');
    assert.ok(check > 0 && check < body.indexOf("switch (service)"), tool);
  }
});
