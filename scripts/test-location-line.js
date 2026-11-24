// Where someone is lives in one place, the saved location, and every prompt
// states it the same way. Setup used to pin it as a fact too, which never
// moved: after a trip, Pulse saw the old country in the Pinned Facts and only
// a time zone for now, and hedged ("if you're still in ...").
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { locationLine } = require("../lib/location");

test("the line names the saved place, or says none is saved", () => {
  assert.equal(locationLine(null), "No location saved.");
  const line = locationLine({ name: "Testville", latitude: 12.5, longitude: 99.25, timezone: "Asia/Bangkok", updated: new Date().toISOString() });
  assert.match(line, /^User's current location: Testville \(12\.5, 99\.25\)\. Use this for all location-aware requests\.$/);
  const landed = locationLine({ name: "Testport", latitude: 1, longitude: 2, source: "flight", landedAt: "2026-01-02T03:04:05Z" });
  assert.match(landed, /Set when their flight landed at 2026-01-02T03:04:05Z/);
});

test("Pulse and the chat are told where the person is by the same line", () => {
  assert.match(read("lib/pulse.js"), /require\("\.\/location"\)\.locationLine\(store\.location\) \+\n\s*"\\n\\n" \+ timeContext\.timeBlock\(store\)/, "and the chat's clock, flights included");
  assert.match(read("lib/engine.js"), /out \+= "\\n\\n" \+ require\("\.\/location"\)\.locationLine\(ctx\.store\.location\);/);
});

test("setup saves the place as the location only, never as a Pinned Fact", () => {
  const onboarding = read("lib/onboarding.js");
  assert.doesNotMatch(onboarding, /profile-location/);
  assert.match(onboarding, /ctx\.store\.location = loc;\n\s*await saveProfileSetting\("location", loc\);/);
  assert.match(read("lib/tools/definitions.js"), /Where they are now is their saved location \(save_location\)\./);
  assert.match(read("migrations/063_location_is_not_a_fact.sql"), /^DELETE FROM facts WHERE key = 'profile-location';$/m, "the place setup pinned before goes");
});

// Asking for a position: only Telegram has a share button. On the web chat
// there was no bot to send one with, and the whole reply to "is it supposed
// to rain later?" failed with "Something went wrong".
test("a tool that needs a position asks with Telegram's button there, and in words everywhere else", async () => {
  const ctx = require("../lib/context");
  const { requestLocation, NO_LOCATION } = require("../lib/location");
  const sent = [];
  const bot = ctx.bot;
  try {
    ctx.bot = null;
    assert.equal(await ctx.runWithInheritedContext(async () => { ctx.activePlatform = "web"; return requestLocation("c1", "u-web", "rain later?"); }), false);
    ctx.bot = { sendMessage: async (chatId, text) => { sent.push(chatId); } };
    assert.equal(await ctx.runWithInheritedContext(async () => { ctx.activePlatform = "whatsapp_linked"; return requestLocation("c2", "u-wa", "rain later?"); }), false, "never Telegram's bot for a WhatsApp chat");
    assert.equal(await ctx.runWithInheritedContext(async () => { ctx.activePlatform = "telegram"; return requestLocation("c3", "u-tg", "rain later?"); }), true);
    assert.deepEqual(sent, ["c3"]);
    assert.equal(ctx.pendingLocationRequests["u-tg"].originalMessage, "rain later?");
    assert.equal(ctx.pendingLocationRequests["u-web"], undefined);
  } finally { ctx.bot = bot; delete ctx.pendingLocationRequests["u-tg"]; }
  assert.match(NO_LOCATION, /Ask where they are/);
  const engine = read("lib/engine.js");
  assert.match(engine, /if \(await requestLocation\(chatId, userId, originalText\)\) return null;/);
  assert.match(engine, /result = \{ error: require\("\.\/location"\)\.NO_LOCATION \};/);
});
