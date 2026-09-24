-- 0001: the record of which migration files have been applied (§11, §13.1).
--
-- The migrate command (platform/src/migrate.ts) applies every file in this
-- directory whose version has no row here, in numeric order, one transaction
-- per file, and inserts the file's row in that same transaction. On an empty
-- database this file runs first and is recorded in its own transaction.
--
-- version is the NNNN of the file name. name is the file name, for the
-- reader; the runner does not compare it.
--
-- This table is the runner's record, not a model, so it has no serial id or
-- uuid (§11).

create table schema_migrations (
  version     integer     primary key check (version > 0),
  name        text        not null,
  applied_at  timestamptz not null default now()
);
