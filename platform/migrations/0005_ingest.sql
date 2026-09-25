-- 0005: what the ingest endpoint needs of uploads (§8.3, §11,
-- platform/src/ingest.ts).
--
-- - mtime may be null: the bridge may send no mtime, and snapshot_at then
--   falls back to the receipt time (§6.2).
-- - client_errors holds the bridge's `client.errors` counters sent with the
--   upload (§8.3, §16.1), until the events table (§16) takes them.
-- - The dedup lookup (§8.3) reads the last upload of one source instance of
--   one device. Its index starts with device_id, so it replaces
--   uploads_device.
--
-- Dropping a NOT NULL, adding a nullable column without a default, and
-- adding or dropping an index rewrite no rows.
--
-- One transaction: a failure in any statement leaves nothing behind.

begin;

alter table uploads alter column mtime drop not null;

-- A JSON object of counter names to whole numbers, e.g.
-- {"locate_failed": 0, "upload_failed": 2}. Null when the bridge sent none.
alter table uploads add column client_errors jsonb;

create index uploads_device_instance_recent
  on uploads (device_id, kit, source_id, instance, id desc);

drop index uploads_device;

commit;
