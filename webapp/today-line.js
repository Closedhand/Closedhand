// The "today" line under the home page's chat box: what is on today and
// tomorrow at a glance, the answer "what's on today?" gives, without asking.
// Timed calendar events, bookings and flights, in the person's own time, one
// entry per thing (a booking and the calendar event made from it are one),
// marked when rain is likely at that hour. A booking whose email gave its day
// but not its time is said with no time, never as midnight.

function localParts(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${String(Number(p.hour) % 24).padStart(2, "0")}:${p.minute}` };
}

// "Reservation at Harbour Grill Old Town, table for 2" reads as "Harbour
// Grill Old Town": what it is, in whole words, at most four. A long "what at
// where" keeps the what ("Shampoo at Lantern Hair Studio" is "Shampoo"), and
// no label ends on a joining word: "London Kings Cross to" read as if the
// time after it were where the train went.
const JOINING = /\s+(to|at|with|for|and|of|the|from|in|on|by)$/i;
function shortLabel(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim()
    .replace(/^(reservation|booking|table|appointment|stay|dinner|lunch)\s+(at|with|for)\s+/i, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+-\s+.*$/, "")
    .replace(/,.*$/, "");
  if (t.length > 26) {
    const what = t.split(/\s+at\s+/i)[0];
    if (what !== t && what.split(" ").length <= 4) return what;
    t = t.split(" ").slice(0, 4).join(" ");
    while (JOINING.test(t)) t = t.replace(JOINING, "");
  }
  return t;
}
// A train, bus or ferry is said by where it goes, as a flight is: "London
// Kings Cross to Newcastle" is "Train to Newcastle".
const JOURNEYS = { train: "Train", bus: "Bus", ferry: "Ferry" };
function journeyLabel(type, title) {
  const m = JOURNEYS[type] && /\s+to\s+(.+)$/i.exec(String(title || ""));
  return m ? `${JOURNEYS[type]} to ${shortLabel(m[1])}` : null;
}

// Words that say what a thing is, a flight number written as one ("QX 416"
// and "QX416" alike).
const words = (s) => new Set(String(s || "").toLowerCase().replace(/\b([a-z]{2}|[a-z]\d|\d[a-z])\s+(\d{1,4})\b/g, "$1$2")
  .split(/[^a-z0-9]+/).filter((w) => w.length > 3 || /^[a-z0-9]{2}\d{1,4}$/.test(w)));
// One thing written down twice: shared words within 45 minutes, or within
// 12 hours a booking and a calendar entry holding its whole name (a stay's
// check-in on the booking, the calendar's at the hotel's own hour). A thing
// with no time of its own is the thing of that name that day: an operator's
// email gave a train's day and the agency's gave its time, and the train
// stood twice, once at "00:00".
function sameThing(a, b) {
  const wa = words(a.raw), wb = words(b.raw);
  const holds = (x, y) => x.size > 0 && [...x].every((w) => y.has(w));
  if (a.untimed || b.untimed) return a.day === b.day && (a.label.toLowerCase() === b.label.toLowerCase() || holds(wa, wb) || holds(wb, wa));
  const apart = Math.abs(a.at - b.at);
  if (apart <= 45 * 60000) {
    for (const w of wa) if (wb.has(w)) return true;
    return false;
  }
  const booking = a.kind === "booking" ? wa : b.kind === "booking" ? wb : null;
  const other = booking === wa ? wb : wa;
  return !!booking && a.kind !== b.kind && apart <= 12 * 3600000 && holds(booking, other);
}

// The day and time where a booking happens (its own zone), else the person's.
function partsThere(ms, zone, tz) {
  if (zone) { try { return localParts(ms, zone); } catch { /* not a zone: the person's below */ } }
  return localParts(ms, tz);
}
// The picture beside an entry: Upcoming's own for that kind of thing
// (webapp/public/upcoming-icons.js), a calendar's page for a calendar entry.
const PICTURED = new Set(["flight", "train", "hotel", "event", "restaurant", "car", "ferry", "bus", "appointment"]);
const pictureOf = (it) => it.kind === "flight" ? "flight" : it.kind === "event" ? "appointment" : PICTURED.has(it.type) ? it.type : "other";

// items: [{ at: ms, raw: "title", kind: "event"|"booking"|"flight", type?: a booking's kind, label?,
//   timeUnknown?, allDay?, zone?: a booking's own time zone }]
function build(items, { tz, now = Date.now(), rainAt = () => false } = {}) {
  const today = localParts(now, tz).day;
  const tomorrow = localParts(now + 86400000, tz).day;
  const on = [];
  for (const it of items) {
    if (!Number.isFinite(it.at)) continue;
    // A booking kept at midnight where it happens because its email gave no
    // time (or it lasts the day) has no time to show and is on all that day,
    // so it is not over half an hour after midnight.
    const there = it.kind === "booking" ? partsThere(it.at, it.zone, tz) : null;
    const untimed = !!there && (!!it.timeUnknown || (!!it.allDay && there.time === "00:00"));
    const { day, time } = untimed ? there : localParts(it.at, tz);
    if (day !== today && day !== tomorrow) continue;
    on.push({ ...it, untimed, day, time: untimed ? "" : time, over: !untimed && it.at < now - 30 * 60000, label: it.label || journeyLabel(it.type, it.raw) || shortLabel(it.raw) });
  }
  // Things with their time first, so of one thing written down twice the one
  // that says when is the one kept. One that is over stays in the reckoning
  // only for its copy with no time, which is over with it: the morning's
  // train came back that afternoon as a train with no time.
  const kept = [];
  const order = { booking: 0, flight: 1, event: 2 };
  for (const it of on.sort((a, b) => (a.untimed - b.untimed) || (order[a.kind] - order[b.kind]))) {
    if (kept.some((k) => (!k.over || it.untimed) && sameThing(k, it))) continue;
    kept.push(it);
  }
  return kept.filter((it) => !it.over).sort((a, b) => a.day.localeCompare(b.day) || (b.untimed - a.untimed) || (a.at - b.at)).slice(0, 4).map((it) => (
    { when: it.day === today ? "today" : "tomorrow", time: it.time, label: it.label, rain: !it.untimed && it.kind !== "flight" && !!rainAt(it.at), icon: pictureOf(it) }
  ));
}

// "Dentist 09:00 · Harbour Grill 19:00, rain likely · Tomorrow: flight to SGN 11:55",
// what a screen reader says for the line the page lays out by day.
function sentence(entries) {
  if (!entries.length) return "";
  const part = (e) => `${e.label}${e.time ? " " + e.time : ""}${e.rain ? ", rain likely" : ""}`;
  const todays = entries.filter((e) => e.when === "today").map(part);
  const tomorrows = entries.filter((e) => e.when === "tomorrow").map(part);
  const out = [];
  if (todays.length) out.push("Today: " + todays.join(" · "));
  if (tomorrows.length) out.push("Tomorrow: " + tomorrows.join(" · "));
  return out.join(" · ");
}

module.exports = { build, sentence, shortLabel, journeyLabel, localParts };
