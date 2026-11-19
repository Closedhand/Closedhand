-- 093_schedule_exact_action.sql: a one-off keeps the exact moment it is for,
-- to the second (a cron line only says the minute, so "in three minutes" used
-- to fire up to a minute early), and a task set for a time can be one step
-- fixed in advance: the tool call Closedhand makes at that moment, by code,
-- with nothing left to decide then (lib/timed-action.js).
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS run_at timestamptz;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS action jsonb;
