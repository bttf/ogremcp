-- 0008: the shared search and page cache (§11, §12), written and read by
-- platform/src/search-cache.ts.
--
-- - One table for both kinds of entry. A search row is keyed by
--   (kit, flavor, scope_hash, normalized_query) and a page row by url (§12).
--   The key columns of the other kind are null, and a check keeps each row to
--   its kind. Nulls are distinct in a unique constraint, so neither
--   constraint sees the other kind's rows.
-- - Not linked to users (§11): "Delete my data" and "Delete account" leave it.
--   No column holds a user id.
-- - scope_hash (§12) is the SHA-256, in hex, of the scope's URL prefixes, the
--   query template, and the provider limit (search.ts). A manifest change to
--   the scope gives new rows a new hash, and the old rows expire.
-- - payload is the answer the provider call gave: a search's hits after the
--   URL-prefix post-filter, or a page's final URL and stripped text. Only
--   successful answers are stored. The code bounds its size: at most 5 hits
--   of bounded fields, or a page text of at most 100,000 characters.
-- - A row whose expires_at has passed is never served. Each write deletes a
--   bounded batch of expired rows, oldest first.
--
-- A new table rewrites no rows.
--
-- One transaction: a failure in any statement leaves nothing behind.

begin;

create table search_cache (
  id                bigint      generated always as identity primary key,
  uuid              uuid        not null default gen_random_uuid() unique,
  kind              text        not null check (kind in ('search', 'page')),
  -- search: the manifest's kit and flavor keys, the scope's hash, and the
  -- agent's query as normalizeQuery writes it, without the site: terms.
  kit               text,
  flavor            text,
  scope_hash        text,
  normalized_query  text,
  -- page: the requested URL, in scope and without its fragment (pageKey).
  url               text,
  payload           jsonb       not null,
  fetched_at        timestamptz not null,
  expires_at        timestamptz not null,
  constraint search_cache_kind_key check (
    case kind
      when 'search' then kit is not null and flavor is not null and scope_hash is not null and normalized_query is not null and url is null
      else kit is null and flavor is null and scope_hash is null and normalized_query is null and url is not null
    end
  ),
  constraint search_cache_search unique (kit, flavor, scope_hash, normalized_query),
  constraint search_cache_page unique (url)
);

create index search_cache_expires_at on search_cache (expires_at);

commit;
