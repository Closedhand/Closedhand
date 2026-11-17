-- Questions asked from the home page's question box (lib/ask.js), counted by
-- day and nothing more: how many were answered, how many visitors asked, how
-- many of them used the day's questions up and how many went on to the
-- download. No question, answer or internet address is kept; closedhand.com
-- cannot read the first two.
CREATE TABLE IF NOT EXISTS site_asks (
  day date PRIMARY KEY,
  asks integer NOT NULL DEFAULT 0,
  askers integer NOT NULL DEFAULT 0,
  capped integer NOT NULL DEFAULT 0,
  went integer NOT NULL DEFAULT 0
);
-- closedhand.com's own key at the provider for those questions, sealed with
-- TOKEN_ENCRYPTION_KEY and kept across restarts, so a deploy never leaves the
-- question box without one.
CREATE TABLE IF NOT EXISTS site_ask_key (
  one boolean PRIMARY KEY DEFAULT true CHECK (one),
  key_id text NOT NULL,
  sealed text NOT NULL
);
