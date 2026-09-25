-- 0011: the device limit's upload slots (§8.3, §14, platform/src/ingest.ts).
--
-- - first_stored_at: when the device's first upload that produced a snapshot
--   was stored. The device limit reads it, not first_upload_at: an upload
--   that fails to parse or has an unsupported flavor is kept as a row and
--   sets first_upload_at (0002), but it claims no slot. The user's live
--   devices hold the tier's slots in the order of first_stored_at; a device
--   without one comes last. A revoked device, or one whose grant is gone,
--   holds none.
-- - first_upload_at keeps its meaning: when the device's first upload was
--   kept as a row, whatever its parse.
-- - Existing devices get the receipt time of their first upload that has a
--   snapshot, so a device that already stored one keeps its place. The
--   update sets only the new column.
--
-- Adding a nullable column without a default rewrites no rows. The update
-- writes one value into it per device that has a snapshot.
--
-- One transaction: a failure in any statement leaves nothing behind.

begin;

alter table devices add column first_stored_at timestamptz;

update devices d
   set first_stored_at = f.received_at
  from (select u.device_id, min(u.received_at) as received_at
          from uploads u
          join snapshots s on s.upload_id = u.id
         group by u.device_id) f
 where f.device_id = d.id;

commit;
