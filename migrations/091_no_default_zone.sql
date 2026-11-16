-- 091_no_default_zone.sql — a time zone is the person's, or none.
--
-- profiles.timezone and automations.trigger_timezone defaulted to one fixed
-- zone, so every new profile claimed to be in it before anyone knew where the
-- person was. With no default, an unknown zone is left empty and the code falls
-- back to the computer's own (lib/timezone.js DEFAULT_TZ). Rows already saved
-- keep their zone.
--
-- Runner-managed: idempotent.

ALTER TABLE profiles ALTER COLUMN timezone DROP DEFAULT;
ALTER TABLE automations ALTER COLUMN trigger_timezone DROP DEFAULT;
