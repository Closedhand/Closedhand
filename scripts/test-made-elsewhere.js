// After a picture or video a connected service made reaches the person, they
// hear once per service that it can see what they asked for, and, where
// Closedhand could make the picture itself, how to keep requests private.
// Invented names only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const made = require("../lib/made-elsewhere");

function deps({ ready = false, imagesOn = null } = {}) {
  const saved = [];
  return { saved, deps: { ready: () => ready, connectionFor: async () => (imagesOn ? { name: imagesOn } : null), save: async (list) => saved.push(list) } };
}

test("a picture says how to keep it private only where switching the service off would do it", async () => {
  let d = deps({ ready: true, imagesOn: "Kestrel Studio" });
  made.made("u1", "Kestrel Studio", "picture");
  assert.equal(await made.take("u1", {}, { deps: d.deps }), "Made with Kestrel Studio, which can see what you asked for. To make sure no other company sees your requests, switch off Image generation on Kestrel Studio in Connections and Closedhand will make your pictures itself, privately.");
  assert.deepEqual(d.saved, [["Kestrel Studio"]]);

  // Nothing private to stand in, or the service has no Image generation switch.
  for (const setup of [{ ready: false, imagesOn: "Kestrel Studio" }, { ready: true, imagesOn: "Another Service" }]) {
    d = deps(setup);
    made.made("u1", "Kestrel Studio", "picture");
    assert.equal(await made.take("u1", {}, { deps: d.deps }), "Made with Kestrel Studio, which can see what you asked for.", JSON.stringify(setup));
  }
  // The subscription's model counts as a private way.
  d = deps({ ready: false, imagesOn: "Kestrel Studio" });
  made.made("u1", "Kestrel Studio", "picture");
  assert.equal(await made.take("u1", { included_api_key: "sk-plan-key-aaaaaaaaaaaaaaaaaaaa", included_ai: { plan: { name: "plus" } } }, { deps: d.deps }), made.LONG.replace(/\{name\}/g, "Kestrel Studio"));
});

test("a video says only who can see it, and each service is told once", async () => {
  const d = deps({ ready: true, imagesOn: "Kestrel Studio" });
  made.made("u1", "Kestrel Studio", "video");
  assert.equal(await made.take("u1", {}, { deps: d.deps }), "Made with Kestrel Studio, which can see what you asked for.");
  made.made("u1", "Kestrel Studio", "picture");
  assert.equal(await made.take("u1", { made_elsewhere_told: ["Kestrel Studio"] }, { deps: d.deps }), null, "said once");
  assert.equal(await made.take("u1", {}, { deps: d.deps }), null, "nothing new made");
  made.made("u1", null, "video");
  assert.equal(await made.take("u1", {}, { deps: d.deps }), null, "no service known, nothing said");
  assert.deepEqual([made.kindOf("video/mp4"), made.kindOf("image/png"), made.kindOf("application/pdf")], ["video", "picture", null]);
  made.used("u1", "Kestrel Studio");
  assert.equal(made.lastService("u1"), "Kestrel Studio");
});

test("noted wherever such a file is sent, and said after the reply as a message of its own", () => {
  assert.match(read("lib/connection-jobs.js"), /require\("\.\/made-elsewhere"\)\.made\(userId, got\.source, "picture"\);/);
  assert.match(read("lib/user-mcp.js"), /madeElsewhere\.made\(userId, entry\.row\.name, madeElsewhere\.kindOf\(file\.mimeType\)\); return deliver\(file\);/);
  assert.match(read("lib/user-mcp.js"), /require\("\.\/made-elsewhere"\)\.used\(userId, entry\.row\.name\);/, "a long job's checks count as using the service");
  assert.match(read("lib/tools/handlers.js"), /madeElsewhere\.made\(sender, madeElsewhere\.lastService\(sender\), madeElsewhere\.kindOf\(file\.mimeType\)\);/);
  assert.match(read("lib/engine.js"), /if \(elsewhere\) finalText = String\(finalText\)\.trim\(\) \+ "\\n\\n\[\[next\]\]\\n\\n" \+ elsewhere;/);
  assert.match(read("lib/tool-waits.js"), /const elsewhere = await require\("\.\/made-elsewhere"\)\.take\(userId, store\.profile\?\.settings, \{ store \}\)/);
  // Settings' Image generation names the connected service first, and how to
  // keep pictures private only where Closedhand could make them itself.
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /escHtml\(svc\) \+ ' makes your pictures, and can see what you ask for\.' \+ \(privately \? ' To keep them private, switch off Image generation on its tile in Connections\.' : ''\)/);
  assert.match(read("webapp/setup-state.js"), /const on = \(data \|\| \[\]\)\.filter\(\(r\) => r\.caps\?\.jobs\?\.images\?\.on\)/);
});
