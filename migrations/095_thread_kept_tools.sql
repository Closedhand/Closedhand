-- The on-demand tools a conversation has loaded (lib/kept-tools.js), kept
-- with its thread so a restart does not lose them: losing them made each one
-- be looked up again in the middle of a reply, and the provider read the
-- whole conversation again at full price each time.
ALTER TABLE conversation_threads ADD COLUMN IF NOT EXISTS kept_tools jsonb NOT NULL DEFAULT '[]'::jsonb;
