// webapp/db.js — the database client, made when first used, so the webapp starts
// with no database set up.
//
// The client is the Postgres driver (db-driver-pg.js), which speaks the query
// shape the code was written against. With no DATABASE_URL every query
// resolves to `{ data: null, error }` instead of throwing, so first-run setup
// can be served rather than crashing.
//
// This is a copy of lib/db.js. The webapp is a separate service and cannot
// import lib/, so the two files must be kept in sync (same as crypto-tokens.js).

function isDbConfigured() {
  return !!process.env.DATABASE_URL;
}

// Where files are kept. Default: local disk, with the app serving /storage/logos/* itself (one box, no
// external accounts). STORAGE_DRIVER=pg keeps files in the database instead, for
// hosts where the bot and the dashboard can't share a folder (Railway).
function buildStorage(client) {
  const which = (process.env.STORAGE_DRIVER || "local").toLowerCase();
  const baseUrl = process.env.BASE_URL || "";
  if (which === "pg") return require("./storage-driver-pg").createPgStorage({ pool: client._pool, baseUrl });
  if (which === "s3") throw new Error("STORAGE_DRIVER=s3 is not implemented yet; use the default local driver (unset STORAGE_DRIVER or set 'local'). S3-compatible support is a planned optional config.");
  return require("./storage-driver-local").createLocalStorage({ dir: process.env.STORAGE_DIR || "./data/storage", baseUrl });
}

let _client = null;
let _tried = false;
function realClient() {
  if (!_tried) {
    _tried = true;
    if (isDbConfigured()) {
      _client = require("./db-driver-pg").createPgClient({ connectionString: process.env.DATABASE_URL, applicationName: "closedhand-webapp" });
      _client.storage = buildStorage(_client); // real storage instead of the data driver's stub
      const rt = require("./realtime-driver-poll").createPollRealtime(_client);
      _client.channel = rt.channel;
      _client.removeChannel = rt.removeChannel;
      _client.removeAllChannels = rt.removeAllChannels;
    }
  }
  return _client;
}

const NOT_CONFIGURED = {
  message: "Database not configured. Complete first-run setup to connect a database.",
  code: "DB_NOT_CONFIGURED",
};
const notConfiguredResult = () => Promise.resolve({ data: null, error: NOT_CONFIGURED });

// Stand-in for the PostgREST query builder: every chained method returns the same
// proxy (so `.select().eq().order().single()…` all chain), and awaiting it yields
// `{ data: null, error }`. Covers `.range()`, `.maybeSingle()`, count-head, etc.
function guardBuilder() {
  const settled = notConfiguredResult();
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return settled.then.bind(settled);
      if (prop === "catch") return settled.catch.bind(settled);
      if (prop === "finally") return settled.finally.bind(settled);
      return () => proxy;
    },
    apply() { return proxy; },
  });
  return proxy;
}

const guardStorageBucket = {
  upload: notConfiguredResult,
  download: notConfiguredResult,
  remove: notConfiguredResult,
  list: notConfiguredResult,
  createSignedUrl: notConfiguredResult,
  getPublicUrl: () => ({ data: { publicUrl: "" } }),
};

const guard = {
  from: () => guardBuilder(),
  rpc: () => notConfiguredResult(),
  storage: { from: () => guardStorageBucket },
  channel: () => {
    const ch = { on: () => ch, subscribe: () => ch, unsubscribe: () => ch };
    return ch;
  },
  removeChannel: () => {},
  removeAllChannels: () => {},
};

// Forward to the real client when configured, else to the guard. Property access
// is lazy, so importing this module connects to nothing.
const supabase = new Proxy({}, {
  get(_t, prop) {
    const target = realClient() || guard;
    const v = target[prop];
    return typeof v === "function" ? v.bind(target) : v;
  },
});

module.exports = { supabase, isDbConfigured };
