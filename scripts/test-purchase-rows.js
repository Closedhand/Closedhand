// The Wallet's Purchases read as purchases: the shop by its name, what it
// cost when known, the page it was on, when and in what, and what happened to
// it in words. Rows read "06/11/2026 08:48 ? co asked, no answer task": the
// shop taken as the part before the last dot of amazon.co.jp, and a "?" for
// an amount never read. Invented shops and pages.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
process.env.CTX_STRICT = "off";
const dash = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "dashboard.html"), "utf8");

function grab(src, name) {
  const at = src.indexOf("function " + name + "(");
  assert.ok(at > 0, name);
  let depth = 0, i = src.indexOf("{", at);
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  return src.slice(at, i + 1);
}

const CASES = [["amazon.co.jp", "Amazon"], ["www.example-shop.co.uk", "Example Shop"], ["groceries.com.au", "Groceries"], ["checkout.example.com", "Example"], ["example.com", "Example"]];

test("a shop goes by its name, whatever its domain ending", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "spend-guard.js"), "utf8");
  const box = {};
  vm.runInNewContext(grab(src, "siteName") + "\nthis.f = siteName;", box);
  for (const [host, name] of CASES) assert.equal(box.f(host), name, host);
  assert.match(src, /const merchant = siteName\(host\);/);
});

test("on the dashboard too, purchases kept before included", () => {
  const box = {};
  vm.runInNewContext(grab(dash, "shopName") + "\nthis.f = shopName;", box);
  for (const [host, name] of CASES) assert.equal(box.f({ host, merchant: "co" }), name, host);
  assert.equal(box.f({ host: "", merchant: "Corner Bakery" }), "Corner Bakery", "no address: the name kept");
});

test("a row says what it cost only when known, the page it was on, when and in what, and what happened in words", () => {
  const row = dash.slice(dash.indexOf("document.getElementById('wallet-ledger').innerHTML"), dash.indexOf("No payments yet."));
  assert.match(row, /var amount = r\.amount_text \|\| \(r\.amount != null \? money\(r\.amount, r\.currency\) : ''\);/);
  assert.doesNotMatch(row, /'\?'/, "never a question mark for an amount not read");
  assert.match(row, /toLocaleDateString\('en-GB', \{ day: 'numeric', month: 'short', year: 'numeric' \}\)/, "the day as every date on the dashboard reads");
  assert.match(row, /\{ agent: 'during a task', automation: 'during a routine', chat: 'from chat' \}\[r\.source\]/);
  assert.match(row, /asked: 'No answer from you', declined: 'You said no', refused: 'Blocked by your limits', failed: 'Did not go through'/);
  assert.match(row, /\.replace\(\/\^\\s\*\[\\w-\]\+\(\\\.\[\\w-\]\+\)\+\\s\*\[:\|\]\\s\*\/, ''\)/, "a page title's leading site name goes");
  assert.match(row, /if \(item\.toLowerCase\(\)\.indexOf\(shop\.toLowerCase\(\)\) === 0\) item = item\.slice\(shop\.length\)/, "and the shop's own name before it");
});
