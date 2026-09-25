-- 0006: keep an upload whose flavor ingest rejects as `unsupported_flavor`
-- (§6.3.1, §8.3, platform/src/ingest.ts), so rejections can be counted by
-- flavor (§16.1).
--
-- - parse_status 'rejected': the interpreter parsed the upload, and its
--   flavor is "unknown" or not in the kit manifest's `flavors`. It has no
--   snapshot.
-- - flavor holds that flavor, e.g. tbc_classic. It is set exactly on
--   rejected uploads; a stored upload's flavor is on its snapshot.
--
-- Adding a nullable column without a default and replacing a check
-- constraint rewrite no rows. Every existing row is 'parsed' or 'failed' with
-- no flavor, so it meets both constraints.
--
-- One transaction: a failure in any statement leaves nothing behind.

begin;

alter table uploads add column flavor text;

alter table uploads drop constraint uploads_parse_status_check;
alter table uploads add constraint uploads_parse_status
  check (parse_status in ('parsed', 'failed', 'rejected'));

alter table uploads add constraint uploads_flavor
  check ((parse_status = 'rejected') = (flavor is not null));

commit;
