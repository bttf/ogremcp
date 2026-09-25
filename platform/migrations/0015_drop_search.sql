-- 0015: drops what the removed search tools stored (§11, §12, §16). The
-- platform no longer searches or fetches pages: search_game_info and
-- fetch_game_page are gone (owner decision, 2026-09-25, RED-368). The owner
-- approved this data drop on 2026-09-25 (RED-370).
--
-- - search_cache (0008): the shared search and page cache. Its indexes and
--   constraints go with it.
-- - events.query, events.cache_hit, and events.search_credits (0007):
--   search_game_info's normalized query, whether the cache answered, and the
--   Firecrawl credits a call used. The check on search_credits goes with its
--   column. No index covers them.
--
-- issues.calls (0009) keeps the query of each call that a report attached
-- before this migration: this file changes no issues row.
--
-- Dropping a table or a column rewrites no rows. A dropped column's values
-- can no longer be read, and their space is reclaimed as their rows are
-- deleted. Each statement takes a brief exclusive lock on its table.
--
-- One transaction: a failure in any statement leaves nothing behind.

begin;

drop table search_cache;

alter table events
  drop column query,
  drop column cache_hit,
  drop column search_credits;

commit;
