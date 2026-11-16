// lib/services/mac-calendar.js: the Mac's own calendar, read through Bridge.
//
// Bridge's calendar.list reads the calendar store directly (EventKit) when it
// has Calendar access, and falls back to asking the Calendar app through
// AppleScript when it doesn't. The sync and live lookups used to send their
// own AppleScript through shell.run instead, which launched Calendar and could
// take most of a minute, or a bundled icalBuddy binary that nothing built.

const { bridgeRequest } = require("./bridge-relay");

// Events from now - daysBack to now + daysAhead, normalised:
// { id, summary, start, end, all_day, location, calendar, description, attendees: [names] }.
// start and end are ISO with offset from EventKit, or the Calendar app's own
// date text from the AppleScript fallback. Throws when Bridge can't answer.
async function readMacCalendar(userId, { daysBack = 0, daysAhead = 7, timeoutMs = 45000 } = {}) {
  const rows = await bridgeRequest(userId, "calendar.list", { days_back: daysBack, days_ahead: daysAhead }, timeoutMs);
  if (!Array.isArray(rows)) throw new Error(rows?.error || "Bridge returned no calendar");
  return rows.map((row, i) => {
    const summary = String(row.title || "");
    const start = String(row.start || "");
    return {
      // EventKit gives a stable id; the AppleScript fallback gives none.
      id: row.id ? String(row.id) : ("mac_" + i + "_" + summary).replace(/[^a-zA-Z0-9]/g, "_").substring(0, 100),
      summary,
      start,
      end: String(row.end || start),
      all_day: row.all_day === true,
      location: String(row.location || ""),
      calendar: String(row.calendar || "Mac Calendar"),
      description: String(row.notes || ""),
      attendees: Array.isArray(row.attendees) ? row.attendees.map(String).filter(Boolean) : [],
    };
  });
}

// The day an event starts on, from the date the model was shown: ISO from the
// calendar store ("2026-10-09T19:00:00+08:00") or the Calendar app's own text
// ("Thursday, 8 October 2026 at 10:00:00"). { year, month, day } or null.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function dayOf(text) {
  const s = String(text || "");
  const real = (year, month, day) => {
    const d = new Date(Date.UTC(year, month - 1, day));
    return month >= 1 && d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? { year, month, day } : null;
  };
  const month = (word) => MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return real(+m[1], +m[2], +m[3]);
  m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/);
  if (m) return real(+m[3], month(m[2]), +m[1]);
  m = s.match(/([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m) return real(+m[3], month(m[1]), +m[2]);
  return null;
}

// The shell command that deletes, in the Mac's Calendar app, the events with
// exactly this title that start on that day, and prints how many went. The
// title is someone else's words (an invitation's), so it is written as an
// AppleScript string and each line as one shell word: a title holding ' or "
// stays a title. It once went into the command with only " escaped, and with
// no day, so one "Lunch" deleted every Lunch there was.
const shellWord = (s) => "'" + String(s).split("'").join("'\\''") + "'";
const appleScriptString = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
function deleteCommand(title, day) {
  if (/[\u0000-\u001f\u007f]/.test(String(title))) throw new Error("That title holds characters a calendar title can't");
  if (!day || ![day.year, day.month, day.day].every(Number.isInteger)) throw new Error("The day the event starts is needed");
  const lines = [
    'tell application "Calendar"',
    "set n to 0",
    "repeat with cal in calendars",
    `set evts to (every event of cal whose summary is ${appleScriptString(title)})`,
    "repeat with e in evts",
    "set d to start date of e",
    `if (year of d) is ${day.year} and ((month of d) as integer) is ${day.month} and (day of d) is ${day.day} then`,
    "delete e",
    "set n to n + 1",
    "end if",
    "end repeat",
    "end repeat",
    "return n",
    "end tell",
  ];
  return "osascript " + lines.map((line) => "-e " + shellWord(line)).join(" ");
}

module.exports = { readMacCalendar, dayOf, deleteCommand, shellWord, appleScriptString };
