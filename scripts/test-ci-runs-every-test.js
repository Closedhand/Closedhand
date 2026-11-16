// Every test file runs in CI. Nine had been written and never listed in
// checks.yml, so their checks were never enforced (found 2026-10-27).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("checks.yml runs every scripts/test-*.js, each once", () => {
  const root = path.join(__dirname, "..");
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/checks.yml"), "utf8");
  const listed = workflow.match(/scripts\/test-[a-z0-9-]+\.js/g) || [];
  const files = fs.readdirSync(path.join(root, "scripts")).filter((f) => /^test-[a-z0-9-]+\.js$/.test(f)).map((f) => "scripts/" + f);
  assert.deepEqual(files.filter((f) => !listed.includes(f)), [], "add these to the run line in checks.yml");
  assert.deepEqual([...new Set(listed.filter((f, i) => listed.indexOf(f) !== i))], [], "listed twice");
});

// One CI job ran Node 20 while every build shipped Node 22, so a package that
// no longer parsed on 20 failed checks for something no build would meet.
test("CI tests on the Node that every build ships", () => {
  const root = path.join(__dirname, "..");
  const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
  const shipped = new Set([
    ...["Dockerfile", "webapp/Dockerfile"].map((f) => read(f).match(/^FROM node:(\d+)/m)[1]),
    read("desktop/build.sh").match(/NODE_VERSION:-v(\d+)\./)[1],
    // The sandbox computer too: it stayed on Node 20 past its end of life.
    read("sandbox-image/Dockerfile").match(/deb\.nodesource\.com\/setup_(\d+)\.x/)[1],
  ]);
  assert.equal(shipped.size, 1, "the builds ship one Node");
  assert.ok(shipped.has(read("lib/engine.js").match(/sandbox computer running Python [\d.]+, Node\.js (\d+), and Bash/)[1]), "and Closedhand is told the sandbox computer's Node as it is");
  assert.doesNotMatch(read("lib/engine.js").match(/Pre-installed: [^.\n]*/)[0], /plotly/, "nothing named as installed that the image lacks");
  for (const name of read("lib/engine.js").match(/Pre-installed: ([^.\n`]*)/)[1].split(",").map((n) => n.trim()).filter(Boolean)) assert.match(read("sandbox-image/Dockerfile"), new RegExp("\\b" + name.replace(/[-.]/g, "[-.]") + "\\b"), name + " is in the image");
  for (const f of fs.readdirSync(path.join(root, ".github/workflows"))) {
    for (const [, v] of read(".github/workflows/" + f).matchAll(/node-version: "(\d+)"/g)) assert.ok(shipped.has(v), `${f} tests Node ${v}`);
  }
});

test("image builds run one at a time, so :latest always ends on the newest commit", () => {
  const root = path.join(__dirname, "..");
  for (const f of ["build-selfhost-images.yml", "build-sandbox.yml"]) {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows", f), "utf8");
    assert.match(workflow, /\nconcurrency:\n  group: [a-z-]+\n  cancel-in-progress: false\n/, f);
    assert.match(workflow, /:latest/, f + " pushes :latest");
  }
});

// The database is Postgres, through one driver. A second client library was
// still loaded by every process and chosen between at start, from when
// Closedhand was hosted, and a switch asked whether this was a Closedhand its
// person runs: it always is.
test("one database client, and no switch for who runs Closedhand", () => {
  const fs = require("node:fs"), path = require("node:path");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  for (const f of ["package.json", "webapp/package.json"]) assert.equal(JSON.parse(read(f)).dependencies["@supabase/supabase-js"], undefined, f);
  for (const f of ["lib/db.js", "webapp/db.js", "lib/mcp-client.js", "webapp/server.js", "docker-compose.yml"]) {
    assert.doesNotMatch(read(f), /@supabase\/supabase-js|SUPABASE_URL|DB_DRIVER|isSelfHost/, f);
  }
  // With no database set up, asking for anything answers plainly instead of throwing.
  const was = process.env.DATABASE_URL; delete process.env.DATABASE_URL;
  try {
    const id = require.resolve("../lib/db"); delete require.cache[id];
    const db = require("../lib/db");
    assert.equal(db.isDbConfigured(), false);
    return db.supabase.from("profiles").select("id").eq("id", "x").single().then((r) => {
      assert.equal(r.data, null);
      assert.equal(r.error.code, "DB_NOT_CONFIGURED");
      delete require.cache[id];
    });
  } finally { if (was !== undefined) process.env.DATABASE_URL = was; }
});
