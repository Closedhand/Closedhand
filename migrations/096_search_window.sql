-- 096_search_window.sql — a search can rank a stretch of time by itself.
--
-- Mail search ranked every email a person had, 30,531 of them, and kept the
-- best 30 by words and the best 30 by meaning, whatever stretch of time was
-- asked for. A draft saved two minutes earlier, holding every word searched
-- for, came 68th by words and 63rd by meaning and was never seen; asked for
-- the last 3 days, 26 to 30 of the 30 it found were older than that.
--
-- filter_since limits both searches to what came in since then. The word
-- search filters inside its query, as 087 does. The meaning search, given a
-- stretch, measures only that stretch's items and their pieces, the newest
-- 2,000, exactly: the HNSW index ranks the whole store first and would filter
-- after, losing the stretch's items behind older ones again.
--
-- Callers name their arguments, so the existing ones keep working. Adding a
-- parameter changes the signature, hence the DROP of the old one.
--
-- Runner-managed: every statement is idempotent (see lib/migrations.js).

DROP FUNCTION IF EXISTS search_data_cache_lexical(uuid, text[], int, text, text, text, int);

CREATE OR REPLACE FUNCTION search_data_cache_lexical(
  match_user_id uuid,
  query_tokens text[],
  match_count int DEFAULT 20,
  filter_type text DEFAULT NULL,
  exclude_type text DEFAULT NULL,
  filter_source text DEFAULT NULL,
  per_type int DEFAULT NULL,
  filter_since timestamptz DEFAULT NULL
) RETURNS TABLE (
  external_id text,
  source text,
  type text,
  data jsonb,
  rank real,
  synced_at timestamptz
) LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  q tsquery := NULL;
  tok text;
  part tsquery;
BEGIN
  IF query_tokens IS NULL OR array_length(query_tokens, 1) IS NULL THEN
    RETURN;
  END IF;

  FOREACH tok IN ARRAY query_tokens LOOP
    part := plainto_tsquery('simple', tok);
    IF part IS NOT NULL AND numnode(part) > 0 THEN
      q := CASE WHEN q IS NULL THEN part ELSE q || part END;
    END IF;
  END LOOP;

  IF q IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT m.external_id, m.source, m.type, m.data, m.rank, m.synced_at
  FROM (
    SELECT dc.external_id, dc.source, dc.type, dc.data, dc.synced_at, dc.received_at,
           ts_rank_cd(dc.fts, q) AS rank,
           row_number() OVER (PARTITION BY dc.type
             ORDER BY ts_rank_cd(dc.fts, q) DESC, dc.received_at DESC NULLS LAST) AS nth
    FROM data_cache dc
    WHERE dc.user_id = match_user_id
      AND (filter_type IS NULL OR dc.type = filter_type)
      AND (exclude_type IS NULL OR dc.type <> exclude_type)
      AND (filter_source IS NULL OR left(dc.source, length(filter_source)) = filter_source)
      AND (filter_since IS NULL OR dc.received_at >= filter_since)
      AND dc.fts @@ q
  ) m
  WHERE per_type IS NULL OR m.nth <= per_type
  ORDER BY m.rank DESC, m.received_at DESC NULLS LAST
  LIMIT match_count;
END
$fn$;

DROP FUNCTION IF EXISTS search_data_vectors(vector, uuid, double precision, integer, text);

CREATE OR REPLACE FUNCTION search_data_vectors(
  query_embedding vector,
  match_user_id uuid,
  match_threshold double precision DEFAULT 0.3,
  match_count integer DEFAULT 15,
  filter_service text DEFAULT NULL,
  filter_since timestamptz DEFAULT NULL
) RETURNS TABLE (
  id uuid,
  service text,
  item_type text,
  external_id text,
  content text,
  source_metadata jsonb,
  enrichment_level text,
  similarity double precision
) LANGUAGE plpgsql AS $fn$
BEGIN
  IF filter_since IS NULL THEN
    RETURN QUERY
    SELECT sv.id, sv.service, sv.item_type, sv.external_id, sv.content,
           sv.source_metadata, sv.enrichment_level,
           1 - (sv.embedding <=> query_embedding) AS similarity
    FROM data_vectors sv
    WHERE sv.user_id = match_user_id
      AND sv.embedding IS NOT NULL
      AND 1 - (sv.embedding <=> query_embedding) > match_threshold
      AND (filter_service IS NULL OR sv.service = filter_service)
    ORDER BY sv.embedding <=> query_embedding
    LIMIT match_count;
    RETURN;
  END IF;

  RETURN QUERY
  WITH items AS (
    SELECT sv.id AS item
    FROM data_cache dc
    JOIN data_vectors sv ON sv.user_id = dc.user_id AND sv.external_id = dc.external_id AND sv.piece_of IS NULL
    WHERE dc.user_id = match_user_id
      AND dc.received_at >= filter_since
      AND (filter_service IS NULL OR sv.service = filter_service)
    ORDER BY dc.received_at DESC
    LIMIT 2000
  ), measured AS (
    SELECT i.item AS vid FROM items i
    UNION
    SELECT sv.id FROM data_vectors sv JOIN items i ON sv.piece_of = i.item
  )
  SELECT sv.id, sv.service, sv.item_type, sv.external_id, sv.content,
         sv.source_metadata, sv.enrichment_level,
         1 - (sv.embedding <=> query_embedding) AS similarity
  FROM measured m
  JOIN data_vectors sv ON sv.id = m.vid
  WHERE sv.embedding IS NOT NULL
    AND 1 - (sv.embedding <=> query_embedding) > match_threshold
  ORDER BY sv.embedding <=> query_embedding
  LIMIT match_count;
END
$fn$;
