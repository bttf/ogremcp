-- 0012: what the daily retention job needs (§11, §14, §19.1 D9,
-- platform/src/retention.ts). The job deletes a free user's expired uploads
-- and snapshots. This file deletes nothing.
--
-- - users.tier_changed_at: when the user's tier last changed. A trigger sets
--   it on every update that changes tier, so no path that changes the tier
--   can miss it: there is no billing yet (§19.1 D5), and the tier changes by
--   SQL. Null for a user whose tier never changed. On a free user it is when
--   the user became free: the job keeps all of that user's history until
--   DOWNGRADE_GRACE_DAYS have passed since then (D9).
-- - Existing users get null, because nothing recorded an earlier change. A
--   user who was downgraded before this migration gets no grace.
-- - uploads_user_received replaces uploads_user. The job reads a free user's
--   uploads by received_at, and the user delete reads them by user_id, which
--   the new index starts with.
--
-- Adding a nullable column without a default, a function, a trigger, and an
-- index, and dropping an index, rewrite no rows.
--
-- One transaction: a failure in any statement leaves nothing behind.

begin;

alter table users add column tier_changed_at timestamptz;

create function users_tier_changed() returns trigger language plpgsql as $$
begin
  new.tier_changed_at := now();
  return new;
end;
$$;

create trigger users_tier_changed
  before update of tier on users
  for each row
  when (old.tier is distinct from new.tier)
  execute function users_tier_changed();

create index uploads_user_received on uploads (user_id, received_at);

drop index uploads_user;

commit;
