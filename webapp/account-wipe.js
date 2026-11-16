// What "Wipe all data" and "Delete account" remove from the database.
//
// Both once kept a list of tables by hand, and both fell behind the schema:
// "Delete account" left goals, pages made in chat, how far back mail was read
// and what the person pays for. Here the tables come from the database itself,
// every one that has a user_id column, so a table added later is covered the
// day it is made. "Wipe all data" names only what it keeps.
const quoted = (name) => '"' + String(name).replace(/"/g, '""') + '"';

// "Your profile and connected services are kept, and mail and calendar keep
// syncing": the connections themselves, what was synced from them and what is
// worked out from that, the person's saved cards and what was spent on them,
// and the record of use. conversations and the assistant-email tables are
// cleared by their own steps in the route.
const KEPT_ON_WIPE = new Set([
  "connections", "connection_clients", "chat_links", "user_mcps", "user_bridges", "sandboxes", "user_skills",
  "data_cache", "data_vectors", "index_progress", "mail_coverage", "email_scans",
  "person_names", "person_links", "bookings", "paying_for",
  "wallet_cards", "wallet_addresses", "spend_ledger", "token_usage",
  "conversations", "assistant_email_accounts", "assistant_email_threads", "assistant_email_messages",
]);

async function userTables(pool, schema = "public") {
  const { rows } = await pool.query(
    `SELECT c.table_name AS name FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = $1 AND c.column_name = 'user_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`, [schema]);
  return rows.map((r) => r.name);
}

// The person's rows go from every table that has them, but those kept. A
// table another still points to fails until that one is emptied, so what
// failed is tried again while a pass still gets somewhere; what cannot be
// emptied stops the run, named, where it used to be logged and passed over.
async function wipeUser(pool, userId, { keep = new Set(), schema = "public" } = {}) {
  let left = (await userTables(pool, schema)).filter((t) => !keep.has(t));
  const emptied = [];
  while (left.length) {
    const failed = [];
    for (const table of left) {
      try { await pool.query(`DELETE FROM ${quoted(schema)}.${quoted(table)} WHERE user_id = $1`, [userId]); emptied.push(table); }
      catch (e) { failed.push({ table, why: e.message }); }
    }
    if (failed.length === left.length) throw new Error(`could not empty ${failed.map((f) => f.table).join(", ")}: ${failed[0].why}`);
    left = failed.map((f) => f.table);
  }
  return emptied;
}

// With the account, what belongs to nobody by name: the files kept in the
// database and every sign-in to the dashboard.
async function wipeShared(pool, schema = "public") {
  for (const table of ["storage_objects", "dashboard_sessions"]) {
    const { rows } = await pool.query("SELECT to_regclass($1) IS NOT NULL AS there", [`${quoted(schema)}.${quoted(table)}`]);
    if (rows[0].there) await pool.query(`DELETE FROM ${quoted(schema)}.${quoted(table)}`);
  }
}

module.exports = { KEPT_ON_WIPE, userTables, wipeUser, wipeShared };
