#!/usr/bin/env node
// scripts/check-commit-zone.js: every commit about to be pushed is dated in UTC.
//
// A commit's dates carry the committing computer's time zone offset, and the
// repo is public, so one offset repeated across the history says roughly where
// its authors live. Dated in UTC, no commit says anything about where it was
// made. The pre-push hook runs this over the commits no remote has yet.
//
//   node scripts/check-commit-zone.js

const { execFileSync } = require("child_process");

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

let lines;
try {
  lines = git("log", "--format=%h %ai|%ci", "HEAD", "--not", "--remotes");
} catch (err) {
  console.error("check-commit-zone: could not list the commits to push");
  process.exit(1);
}

const bad = lines.split("\n").filter(Boolean).filter((line) => {
  const [author, committer] = line.slice(line.indexOf(" ") + 1).split("|");
  return !author.endsWith(" +0000") || !committer.endsWith(" +0000");
});

if (bad.length) {
  console.error("check-commit-zone: these commits are not dated in UTC:");
  for (const line of bad) console.error("  " + line);
  console.error("Make commits with TZ=UTC. To redate the newest one:");
  console.error("  TZ=UTC GIT_COMMITTER_DATE=\"$(date -u +%FT%TZ)\" git commit --amend --no-edit --date=now");
  process.exit(1);
}
