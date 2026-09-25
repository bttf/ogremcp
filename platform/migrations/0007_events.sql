-- 0007: the events table (§11, §16): one row per MCP tool call and one per
-- ingest request, written by platform/src/events.ts. /admin reads it for the
-- §16.1 metrics. Visits (§3) are derived from the gaps between a user's
-- tool-call rows (`VISITS_SQL` in events.ts); there are no MCP session ids
-- (D12).
--
-- - Every row belongs to a user, and deleting the user deletes it (§11,
--   "Delete account"). "Delete my data" deletes the user's rows too.
-- - query holds search_game_info's normalized query, for the §16.1 search
--   metrics. It can hold a character's or another player's name, so it is
--   user data and goes with "Delete my data" (§11, §16.2). No other column
--   holds text the agent or the player wrote: sections and flavor keep only
--   the names a tool or a kit defines.
-- - client_errors holds the bridge's `client.errors` counters (§8.3,
--   §16.1). The bridge counts since the last upload stored as a row, so a
--   sum over time reads the rows whose status is stored, parse_error, or
--   unsupported_flavor.
--
-- A new table rewrites no rows.
--
-- One transaction: a failure in any statement leaves nothing behind.

begin;

create table events (
  id                    bigint      generated always as identity primary key,
  uuid                  uuid        not null default gen_random_uuid() unique,
  user_id               bigint      not null references users (id) on delete cascade,
  -- When the tool call or the ingest request reached the server.
  occurred_at           timestamptz not null,
  kind                  text        not null check (kind in ('tool_call', 'ingest')),
  -- From receipt to the answer, in milliseconds.
  latency_ms            integer     not null check (latency_ms >= 0),

  -- tool_call: the OAuth client ID of the agent's access token (§9).
  agent_client          text,
  -- tool_call: the tool's name, e.g. wow_get_state.
  tool                  text,
  -- tool_call: the args summary (§16). The `sections` the tool's schema
  -- names, and a `flavor` that is a kit's flavor key. Null when the call
  -- gave none.
  sections              text[],
  -- tool_call: the `flavor` argument. ingest: the upload's flavor, rejected
  -- ones included (§16.1).
  flavor                text,
  -- tool_call: search_game_info's normalized query. User data (see above).
  query                 text,
  -- tool_call: why the call answered an error, e.g. user_error, game_off,
  -- failed, or search_unavailable. A category, never the message. Null when
  -- the call succeeded.
  error                 text,
  -- tool_call: occurred_at minus the `snapshot_at` of the snapshot the call
  -- returned, in seconds. Negative when the player's clock runs ahead.
  snapshot_age_seconds  integer,
  -- tool_call: whether the search cache answered (§12). Null until the cache
  -- exists, and for tools that do not search.
  cache_hit             boolean,
  -- tool_call: the Firecrawl credits the call used, when Firecrawl said.
  search_credits        integer     check (search_credits >= 0),

  -- ingest: the device of the bridge's token (§8.1). A device is deleted
  -- only with its user, which deletes the row too; the row never blocks it.
  device_id             bigint      references devices (id) on delete set null,
  -- ingest: the §8.3 status of the answer.
  status                text        check (status in ('stored', 'duplicate', 'parse_error', 'unsupported_flavor', 'too_large',
                                                      'device_limit', 'rate_limited', 'bad_request')),
  -- ingest: the upload's parse_status, when the upload was parsed.
  parse_status          text        check (parse_status in ('parsed', 'failed', 'rejected')),
  -- ingest: meta.kit, and the manifest version of the kit that read it.
  kit                   text,
  kit_version           text,
  -- ingest: the adapter schema of a parsed upload.
  adapter_schema        integer,
  -- ingest: meta.client (§8.3).
  bridge_version        text,
  os                    text,
  client_errors         jsonb,

  constraint events_tool_call check (kind <> 'tool_call' or (agent_client is not null and tool is not null)),
  constraint events_ingest check (kind <> 'ingest' or status is not null)
);

-- By time, across users (§16.1).
create index events_occurred on events (occurred_at);
-- By user and time: visits, a user's history, and the user delete.
create index events_user_occurred on events (user_id, occurred_at);
-- By kind, then tool, and time: calls per tool, ingest by status (§16.1).
create index events_kind_tool_occurred on events (kind, tool, occurred_at);
-- A device's ingest rows, and the device delete.
create index events_device on events (device_id) where device_id is not null;

commit;
