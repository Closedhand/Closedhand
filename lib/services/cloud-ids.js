// lib/services/cloud-ids.js: which mail and events came from a connected
// account, by their own ids, so a copy of the same one read from the Mac
// through Bridge is not indexed twice.
//
// Only the ids are read. The index sweep once read every synced email and
// event whole to get them (bodies and all, at once, on the first sync after
// every start): about 1.9 GB of JavaScript objects on a mailbox of a year, held
// for the pass, to look at one short field in each.

// The Message-ID of every email synced from these sources.
async function cloudMessageIds(supabase, userId, sources) {
  const ids = new Set();
  if (!sources || !sources.length) return ids;
  const { data } = await supabase
    .from("data_cache")
    .select("data->>messageId_header, data->>messageId, data->>id")
    .eq("user_id", userId)
    .eq("type", "email")
    .in("source", sources);
  for (const row of data || []) {
    const id = row.messageId_header || row.messageId || row.id || "";
    if (id) ids.add(id);
  }
  return ids;
}

// The calendar's own id (iCalUID) of every event synced from Google or Outlook.
async function cloudEventUids(supabase, userId) {
  const uids = new Set();
  const { data } = await supabase
    .from("data_cache")
    .select("data->>uid, data->>iCalUID")
    .eq("user_id", userId)
    .eq("type", "event")
    .in("source", ["gcal", "outlook_cal"]);
  for (const row of data || []) {
    const uid = row.uid || row.iCalUID || "";
    if (uid) uids.add(uid);
  }
  return uids;
}

module.exports = { cloudMessageIds, cloudEventUids };
