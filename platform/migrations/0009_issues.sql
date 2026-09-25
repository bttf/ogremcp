-- 0009: the issues table (§11, §16.2): one row per report_issue call that
-- recorded a report, written by platform/src/report-issue.ts. /admin reads it
-- for the §16.1 quality metric. And events.snapshot_uuid, which says which
-- snapshot a tool call returned, so that a report can name the snapshot the
-- agent read.
--
-- - Every row belongs to a user, and deleting the user deletes it (§11,
--   "Delete account"). "Delete my data" deletes the user's rows too.
-- - note is the agent's summary of the user's report, and calls holds the
--   visit's search queries: both are user data (§11, §16.2).
-- - snapshot_uuid and snapshot_at name a snapshot, and hold none of its
--   state. They are not a foreign key: the reference outlives the snapshot
--   when retention deletes it (§11).
--
-- A new table and a new nullable column without a default rewrite no rows.
--
-- One transaction: a failure in any statement leaves nothing behind.

begin;

create table issues (
  id             bigint      generated always as identity primary key,
  uuid           uuid        not null default gen_random_uuid() unique,
  user_id        bigint      not null references users (id) on delete cascade,
  created_at     timestamptz not null default now(),
  -- The report_issue `game` argument: a kit key the user had enabled.
  kit            text        not null,
  -- The agent's note, trimmed. NOTE_MAX_CHARS in report-issue.ts matches the
  -- bound.
  note           text        not null check (char_length(note) between 1 and 1000),
  -- The OAuth client ID of the agent's access token (§9).
  agent_client   text        not null,
  -- The visit's recent tool calls (§3, §16), oldest first: a JSON array of
  -- {occurred_at, tool, sections, flavor, query, error}, as the events rows
  -- hold them. error is null for a call that succeeded.
  calls          jsonb       not null check (jsonb_typeof(calls) = 'array'),
  -- The snapshot the agent read most recently in the visit, or null.
  snapshot_uuid  uuid,
  snapshot_at    timestamptz,
  constraint issues_snapshot check ((snapshot_uuid is null) = (snapshot_at is null))
);

-- By user and time: the per-user report limit, and the user delete.
create index issues_user_created on issues (user_id, created_at);
-- By time, across users (§16.1).
create index issues_created on issues (created_at);

-- tool_call: the uuid of the snapshot whose state the call returned, from a
-- kit tool such as wow_get_state. Null for other calls. Not a foreign key,
-- as above.
alter table events add column snapshot_uuid uuid;

commit;
