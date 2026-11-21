-- What the person pays for (lib/paying-for.js) is read whole once a week and
-- added to in between, when something new looks like paying. built_at is the
-- last time anything was read; rebuilt_at is the last time all of it was. A
-- picture from before this has none, and counts as read whole when built.
ALTER TABLE paying_for ADD COLUMN IF NOT EXISTS rebuilt_at timestamp with time zone;
