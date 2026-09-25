-- 0010: the usage_daily table (§11, §14): how many MCP tool calls each user
-- made on each UTC day, written by platform/src/usage.ts. The tier's daily
-- cap (TOOL_CALLS_PER_DAY_FREE and TOOL_CALLS_PER_DAY_PAID) is checked
-- against it before a tool runs.
--
-- - One row per user and UTC day. A call adds 1 with an upsert that also
--   checks the cap, in one statement, so concurrent calls cannot pass it.
--   A call the cap refuses adds nothing.
-- - users.tier is `free` or `paid` since 0002, and new users are `free`.
--   This file does not change it.
-- - Every row belongs to a user, and deleting the user deletes it (§11,
--   "Delete account"). "Delete my data" keeps it: §11 does not list it, and
--   the count holds nothing the agent or the player wrote.
--
-- A new table rewrites no rows.
--
-- One transaction: a failure in any statement leaves nothing behind.

begin;

create table usage_daily (
  id          bigint  generated always as identity primary key,
  uuid        uuid    not null default gen_random_uuid() unique,
  user_id     bigint  not null references users (id) on delete cascade,
  -- The UTC date of the calls.
  day         date    not null,
  tool_calls  integer not null check (tool_calls >= 0),
  -- Also the index of the user delete.
  constraint usage_daily_user_day unique (user_id, day)
);

commit;
