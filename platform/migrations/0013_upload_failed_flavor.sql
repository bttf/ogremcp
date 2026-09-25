-- 0013: keep the flavor of an upload that fails to parse, when the
-- interpreter detected one before it failed (§6.2 `ParseError`, §16.1,
-- platform/src/ingest.ts), so parse errors can be counted by flavor.
--
-- - flavor stays set on every rejected upload, and null on every parsed one,
--   whose flavor is on its snapshot (0006). A failed upload may now have one.
-- - adapter_schema already allows a failed upload's schema (0002).
--
-- Replacing a check constraint rewrites no rows. Every existing row meets the
-- new constraint, because the one it replaces is stricter.
--
-- One transaction: a failure in any statement leaves nothing behind.

begin;

alter table uploads drop constraint uploads_flavor;

alter table uploads add constraint uploads_flavor
  check ((parse_status <> 'rejected' or flavor is not null) and (parse_status <> 'parsed' or flavor is null));

commit;
