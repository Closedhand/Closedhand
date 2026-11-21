// The tools a conversation has loaded are kept with its thread
// (lib/kept-tools.js), so a restart does not lose them and the next reply's
// tool list is the one the provider still has cached.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const kept = require("../lib/kept-tools");

// A stand-in for the database: one table, the calls the module makes.
function fakeDb(rows = {}, { failRead = false, failWrite = false } = {}) {
  const writes = [];
  return {
    writes,
    from(table) {
      assert.equal(table, "conversation_threads");
      const where = {};
      let patch = null;
      const q = {
        select() { return q; },
        update(p) { patch = p; return q; },
        eq(col, v) { where[col] = v; return patch ? q : q; },
        maybeSingle() {
          if (failRead) return Promise.resolve({ data: null, error: { message: 'column "kept_tools" does not exist' } });
          const row = rows[where.id];
          return Promise.resolve({ data: row && row.user_id === where.user_id ? { kept_tools: row.kept_tools } : null, error: null });
        },
        then(resolve) {
          if (failWrite) return resolve({ error: { message: "offline" } });
          writes.push({ id: where.id, user_id: where.user_id, ...patch });
          if (rows[where.id]) rows[where.id].kept_tools = patch.kept_tools;
          return resolve({ error: null });
        },
      };
      return q;
    },
  };
}

test("after a restart a conversation has the tools it had, in the order it had them", async () => {
  kept._reset();
  const db = fakeDb({ t1: { user_id: "u1", kept_tools: ["sandbox_browse", "gmail_send"] } });
  const set = kept.get("u1", "t1");
  set.add("weather_lookup"); // loaded by this reply before the thread was read
  await kept.ready("u1", "t1", db);
  assert.deepEqual([...kept.get("u1", "t1")], ["sandbox_browse", "gmail_send", "weather_lookup"]);
  assert.equal(await kept.save("u1", "t1", db), true, "the new one is kept");
  assert.deepEqual(db.writes, [{ id: "t1", user_id: "u1", kept_tools: ["sandbox_browse", "gmail_send", "weather_lookup"] }]);
  assert.equal(await kept.save("u1", "t1", db), false, "nothing new, nothing written");
  assert.equal(db.writes.length, 1);
  await kept.ready("u1", "t1", db);
  assert.equal(kept.get("u1", "t1").size, 3, "read once a process");
});

test("another person's thread, a thread with nothing kept, or a database without the column starts empty, and a reply never fails on it", async () => {
  kept._reset();
  const db = fakeDb({ t1: { user_id: "someone-else", kept_tools: ["gmail_send"] } });
  await kept.ready("u1", "t1", db);
  assert.equal(kept.get("u1", "t1").size, 0);
  kept._reset();
  const quiet = console.warn; const warned = []; console.warn = (m) => warned.push(m);
  try {
    await kept.ready("u1", "t2", fakeDb({}, { failRead: true }));
    assert.equal(kept.get("u1", "t2").size, 0);
    kept.get("u1", "t2").add("gmail_send");
    assert.equal(await kept.save("u1", "t2", fakeDb({}, { failWrite: true })), false);
    assert.equal(warned.length, 1, "said once, not on every reply");
  } finally { console.warn = quiet; }
  assert.equal(await kept.save("u1", null, fakeDb({})), false, "no thread, nothing written");
});

test("a list kept for a long time holds the latest tools, not every one ever used", async () => {
  kept._reset();
  const db = fakeDb({ t1: { user_id: "u1", kept_tools: [] } });
  await kept.ready("u1", "t1", db);
  for (let i = 0; i < kept.MAX_KEPT + 5; i++) kept.get("u1", "t1").add("tool_" + i);
  await kept.save("u1", "t1", db);
  const written = db.writes.at(-1).kept_tools;
  assert.equal(written.length, kept.MAX_KEPT);
  assert.equal(written.at(-1), "tool_" + (kept.MAX_KEPT + 4));
});

test("the chat reads the kept list before a reply and keeps it after", () => {
  const engine = fs.readFileSync(path.join(__dirname, "..", "lib", "engine.js"), "utf8");
  assert.match(engine, /await require\("\.\/kept-tools"\)\.ready\(userId, ctx\.activeThreadId\);\n\s+const loadedTools = keptTools\(userId, ctx\.activeThreadId\);/);
  assert.match(engine, /function keptTools\(userId, threadId\) \{\n\s+return require\("\.\/kept-tools"\)\.get\(userId, threadId\);/);
  assert.match(engine, /else forgetTurn\(userId, ctx\.activeThreadId\);\n\s+require\("\.\/kept-tools"\)\.save\(userId, ctx\.activeThreadId\)\.catch\(/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "migrations", "095_thread_kept_tools.sql"), "utf8"), /ALTER TABLE conversation_threads ADD COLUMN IF NOT EXISTS kept_tools jsonb NOT NULL DEFAULT '\[\]'::jsonb;/);
});
