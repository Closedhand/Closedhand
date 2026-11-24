// A connected server is shown by a name a person reads, and its tile holds it
// whole. Xero's server called itself "EcosystemRemoteMcpServer", and its tile
// said so, the name pushing "Connected" and the arrow out of the tile. Known
// servers take the catalogue's name; any other, its own name read as words or
// else its address's; a name made for code is never shown. Invented
// addresses, but for the companies' own published servers.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const server = read("webapp/server.js");

function grab(src, name) {
  const at = src.indexOf("function " + name + "(");
  assert.ok(at > 0, name);
  let depth = 0, i = src.indexOf("{", at);
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  return src.slice(at, i + 1);
}

test("a server's own name is shown only when it reads as words", () => {
  const box = { URL };
  vm.runInNewContext([grab(server, "readsAsCode"), grab(server, "mcpNameFromUrl"), grab(server, "mcpDisplayName"), "this.named = mcpDisplayName; this.code = readsAsCode;"].join("\n"), box);
  for (const [declared, url, shown] of [
    ["EcosystemRemoteMcpServer", "https://api.xero.com/mcp/v1", "Xero"],
    ["Xero MCP Server", "https://api.xero.com/mcp/v1", "Xero"],
    ["notion-mcp", "https://mcp.notion.com/mcp", "Notion"],
    ["notes_server", "https://mcp.example-notes.test/mcp", "Example Notes"],
    ["GitHub", "https://api.githubcopilot.com/mcp/", "GitHub"],
    ["HubSpot", "https://mcp.hubspot.com/", "HubSpot"],
    ["Field Notes", "https://mcp.example-notes.test/mcp", "Field Notes"],
    ["", "https://mcp.example-crm.test/v1", "Example Crm"],
  ]) assert.equal(box.named({ name: declared }, url), shown, declared || "(none)");
  assert.equal(box.code("GitHub"), false, "one capital inside a word is a brand, not code");
});

test("a server Closedhand knows takes the catalogue's name, before any guess", () => {
  const catalogue = require("../webapp/connection-catalogue").createCatalogue({
    db: {}, services: { notion: { name: "Notion" }, slack: { name: "Slack" } }, userId: () => "u1", baseUrl: "https://quiet-isle-00.closedhand.test",
  });
  assert.equal(catalogue.knownName("https://api.xero.com/mcp/v1"), "Xero");
  assert.equal(catalogue.knownName("https://mcp.notion.com/mcp"), "Notion");
  assert.equal(catalogue.knownName("https://mcp.example-crm.test/v1"), null);
  assert.match(server, /name: String\(explicitName \|\| ""\)\.trim\(\) \|\| row\.name \|\| connectionCatalogue\.knownName\(row\.server_url\) \|\| await resolveMcpName\(/);
  assert.match(grab(server, "nameViaModel"), /!readsAsCode\(name\)\) return name;\n\s*console\.log\("\[mcp-name\]/, "the model's name too, and a name not used is said in the log");
});

test("a tile holds its name whole: a long one takes a second line, and Connected and the arrow keep their place", () => {
  const dash = read("webapp/views/dashboard.html");
  const rule = dash.slice(dash.indexOf("    .int-card .int-name {\n      /* Never abbreviate"), dash.indexOf("    .int-card .int-badge { flex: none; }"));
  assert.match(rule, /white-space: normal;\n\s*min-width: 0;\n\s*overflow-wrap: anywhere;/);
  assert.doesNotMatch(rule, /max-content|nowrap|ellipsis|line-clamp/, "never cut, never held wider than its tile");
  assert.match(dash, /\.int-card \.int-badge \{ flex: none; \}/);
});

// Xero's "your app needs to be on a paid plan" was read as the organisation's
// Xero subscription, and its owner told to upgrade that: a known server's
// misleading error goes to the LLM with what it means beside it.
test("a known server's misleading error is said with what it means", () => {
  const src = read("lib/user-mcp.js");
  const box = { URL };
  vm.runInNewContext(src.slice(src.indexOf("const ERROR_NOTES = ["), src.indexOf("];", src.indexOf("const ERROR_NOTES = [")) + 2) + "\n" + grab(src, "errorNote") + "\nthis.f = errorNote;", box);
  const xero = "To use Xero’s Remote MCP server with this organisation, your app needs to be on a paid plan. Free plans can only be used with demo organisations.";
  const said = box.f("https://api.xero.com/mcp/v1", xero);
  assert.ok(said.startsWith(xero), "Xero's own words first");
  assert.match(said, /not their organisation's Xero subscription/);
  assert.match(said, /Core developer plan or above, chosen for the app in My Apps at developer\.xero\.com/);
  assert.equal(box.f("https://mcp.example-crm.test/v1", "your app needs to be on a paid plan"), "your app needs to be on a paid plan", "only where it is known to mislead");
  assert.equal(box.f("stdio:npx -y @acme/acme-mcp", "boom"), "boom");
  assert.match(src, /if \(rendered\.isError\) throw new Error\(errorNote\(entry\.row\.server_url, rendered\.text\)\);/);
});
