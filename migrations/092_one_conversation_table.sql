-- 092_one_conversation_table.sql — the conversation lives in its thread alone.
--
-- conversations held a second copy of the open conversation, written whole
-- beside conversation_threads on every save and read on every load. Every
-- load already makes or finds a thread, so the copy held nothing the active
-- thread does not.
--
-- Runner-managed: idempotent.

DROP TABLE IF EXISTS conversations;
