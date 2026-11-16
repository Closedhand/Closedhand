// A database that starts empty (Railway's, a managed Postgres) gets the whole
// schema from the bot, as Docker's first-start scripts give it: the baseline,
// then every runner-managed migration, and nothing twice.
// Run: DATABASE_URL=postgres://... (with pgvector) node --test scripts/test-fresh-database.js
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { runPendingMigrations, _internals } = require("../lib/migrations");

let pool;
before(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
});
after(async () => { await pool?.end(); });

const tables = async () => (await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n;

test("an empty database gets the baseline and every migration, once", async () => {
  assert.equal(await tables(), 0);
  await runPendingMigrations(pool);
  assert.ok((await pool.query("SELECT to_regclass('public.profiles') IS NOT NULL AS ok")).rows[0].ok, "baseline tables exist");
  const managed = fs.readdirSync(path.join(__dirname, "..", "migrations")).filter(_internals.runnerManaged).sort();
  const applied = (await pool.query("SELECT filename FROM schema_migrations ORDER BY filename")).rows.map(r => r.filename);
  assert.deepEqual(applied, managed, "every runner-managed migration is recorded");
  const count = await tables();
  await runPendingMigrations(pool);
  assert.equal(await tables(), count, "a second boot changes nothing");
});

test("a database that already has the schema is left as it is", async () => {
  await pool.query("CREATE TABLE IF NOT EXISTS marker (id int)");
  await _internals.ensureBaseline(pool);
  assert.ok((await pool.query("SELECT to_regclass('public.marker') IS NOT NULL AS ok")).rows[0].ok);
});

test("files kept in the database: saved, read back, replaced and removed, and paths can't climb out", async () => {
  const { createPgStorage } = require("../lib/storage-driver-pg");
  const files = createPgStorage({ pool, baseUrl: "https://example.test" }).from("attachments");
  assert.equal((await files.upload("u1/note.txt", Buffer.from("first"), { contentType: "text/plain", upsert: true })).error, null);
  assert.equal((await files.upload("u1/note.txt", Buffer.from("second"), { contentType: "text/plain", upsert: true })).error, null);
  const got = await files.download("u1/note.txt");
  assert.equal(Buffer.from(await got.data.arrayBuffer()).toString(), "second");
  assert.equal(got.data.type, "text/plain");
  assert.equal((await files.download("u1/missing.txt")).error.message, "Object not found");
  for (const bad of ["../logos/x", "/abs", "a//b", "a/./b", ""]) assert.match((await files.upload(bad, Buffer.from("x"))).error.message, /Invalid/, bad);
  await files.remove(["u1/note.txt"]);
  assert.equal((await files.download("u1/note.txt")).error.message, "Object not found");
  assert.equal(createPgStorage({ pool }).from("logos").getPublicUrl("a.svg").data.publicUrl, "/storage/logos/a.svg");
});

test("the word search finds the words inside an email or web address, not the mail provider's", async () => {
  // Invented items: an agency's address and its site, each alone in a message,
  // and an email whose only addresses are in its From and To lines.
  const me = "33333333-3333-3333-3333-333333333333";
  await pool.query(`INSERT INTO data_cache (user_id, source, type, external_id, data, received_at) VALUES
    ($1, 'whatsapp', 'message', 'wa-1', $2, now()), ($1, 'whatsapp', 'message', 'wa-2', $3, now()), ($1, 'gmail', 'email', 'e-1', $4, now())`,
    [me, { text: "office@harbour-homes.example" }, { text: "https://www.harbour-homes.example/team" }, { from: "Sam Fixture <sam.fixture@gmail.com>", to: "me@outlook.com", body: "See you Friday" }]);
  const found = async (words) => (await pool.query("SELECT external_id FROM search_data_cache_lexical($1, $2, 20)", [me, words])).rows.map((r) => r.external_id).sort();
  assert.deepEqual(await found(["harbour", "homes"]), ["wa-1", "wa-2"], "the agency by its name, from its address and its link");
  assert.deepEqual(await found(["office@harbour-homes.example"]), ["wa-1"], "the whole address still");
  assert.deepEqual(await found(["gmail"]), [], "a free mail provider's name says nothing about whose address it is");
  assert.deepEqual(await found(["www"]), []);
  assert.deepEqual(await found(["fixture"]), ["e-1"], "the sender by name, as before");
});

// "Delete account" and "Wipe all data" kept their lists of tables by hand, and
// both fell behind the schema: goals, pages made in chat, how far back mail
// was read and what the person pays for outlived a deleted account.
test("an account's rows go from every table that has them, whatever order they point to each other in", async () => {
  const wipe = require("../webapp/account-wipe");
  await pool.query(`DROP SCHEMA IF EXISTS wipetest CASCADE; CREATE SCHEMA wipetest;
    CREATE TABLE wipetest.people (id text PRIMARY KEY);
    CREATE TABLE wipetest.jobs (id serial PRIMARY KEY, user_id text NOT NULL);
    CREATE TABLE wipetest.papers (id serial PRIMARY KEY, user_id text NOT NULL, job_id int REFERENCES wipetest.jobs(id));
    CREATE TABLE wipetest.aims (id serial PRIMARY KEY, user_id uuid NOT NULL);
    CREATE TABLE wipetest.links (id serial PRIMARY KEY, user_id text NOT NULL);
    CREATE TABLE wipetest.settings (key text PRIMARY KEY, value text);
    CREATE VIEW wipetest.mine AS SELECT user_id FROM wipetest.jobs;
    INSERT INTO wipetest.jobs (user_id) VALUES ('u1'), ('u2');
    INSERT INTO wipetest.papers (user_id, job_id) VALUES ('u1', 1), ('u2', 2);
    INSERT INTO wipetest.aims (user_id) VALUES ('00000000-0000-4000-8000-000000000001');
    INSERT INTO wipetest.links (user_id) VALUES ('u1');
    INSERT INTO wipetest.settings VALUES ('theme', 'dark');`);
  const count = async (t, where = "") => (await pool.query(`SELECT count(*)::int AS n FROM wipetest.${t} ${where}`)).rows[0].n;
  assert.deepEqual(await wipe.userTables(pool, "wipetest"), ["aims", "jobs", "links", "papers"], "tables with a user_id, no views");

  // jobs cannot go while a paper points to it; papers comes later in the
  // alphabet, so the first pass fails on jobs and the second finishes it.
  const emptied = await wipe.wipeUser(pool, "u1", { schema: "wipetest", keep: new Set(["links", "aims"]) });
  assert.deepEqual(emptied.sort(), ["jobs", "papers"]);
  assert.equal(await count("jobs", "WHERE user_id = 'u1'"), 0);
  assert.equal(await count("papers", "WHERE user_id = 'u1'"), 0);
  assert.equal(await count("jobs", "WHERE user_id = 'u2'"), 1, "someone else's rows stay");
  assert.equal(await count("links"), 1, "what is kept stays");
  assert.equal(await count("settings"), 1);

  await wipe.wipeUser(pool, "00000000-0000-4000-8000-000000000001", { schema: "wipetest", keep: new Set(["jobs", "papers", "links"]) });
  assert.equal(await count("aims"), 0, "a uuid user_id too");

  // What cannot be emptied stops the run and is named.
  await pool.query(`CREATE TABLE wipetest.held (id serial PRIMARY KEY, job_id int REFERENCES wipetest.jobs(id)); INSERT INTO wipetest.held (job_id) VALUES (2)`);
  await assert.rejects(wipe.wipeUser(pool, "u2", { schema: "wipetest", keep: new Set(["papers", "links", "aims"]) }), /could not empty jobs/);
  await pool.query("DROP SCHEMA wipetest CASCADE");
});

test("the real schema: the tables that outlived a deleted account are found, and every table kept on a wipe exists", async () => {
  const wipe = require("../webapp/account-wipe");
  const found = new Set(await wipe.userTables(pool));
  for (const t of ["goals", "reports", "paying_for", "mail_coverage", "projects", "facts", "conversation_threads", "data_cache"]) assert.ok(found.has(t), `${t} is found`);
  for (const t of wipe.KEPT_ON_WIPE) assert.ok(found.has(t), `${t}, kept on a wipe, is a table with a user_id`);
  assert.ok(!found.has("profiles") && !found.has("schema_migrations"));
  // Deleting everything for a person the database has never seen changes
  // nothing and fails nowhere: every table takes the delete.
  const emptied = await wipe.wipeUser(pool, "00000000-0000-4000-8000-0000000000aa");
  assert.equal(emptied.length, found.size);
  await wipe.wipeShared(pool);
});
