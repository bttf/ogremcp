-- 0002: the base tables of §11: users and their sign-in, devices, enabled
-- kits, uploads, and snapshots. The OAuth tables, search_cache, events,
-- issues, usage_daily, and subscriptions come with their own issues.
--
-- Every table has a serial id (an identity column) and a uuid (§11). Foreign
-- keys reference the id. The id is internal: no API response, page, tool
-- result, or log line shows it. They show the uuid.
--
-- Every row that belongs to a user references users, and deleting the user
-- deletes it (§11, "Delete account").
--
-- One transaction: a failure in any statement leaves nothing behind.

begin;

create table users (
  id          bigint      generated always as identity primary key,
  uuid        uuid        not null default gen_random_uuid() unique,
  -- §14. The tier changes only hosted-service limits.
  tier        text        not null default 'free' check (tier in ('free', 'paid')),
  created_at  timestamptz not null default now()
);

-- A Google or Discord account linked to a user (§13.1).
create table oauth_identities (
  id                bigint      generated always as identity primary key,
  uuid              uuid        not null default gen_random_uuid() unique,
  user_id           bigint      not null references users (id) on delete cascade,
  provider          text        not null check (provider in ('google', 'discord')),
  -- The provider's stable id for the account, e.g. Google's `sub`.
  provider_user_id  text        not null,
  created_at        timestamptz not null default now(),
  constraint oauth_identities_provider_user unique (provider, provider_user_id)
);

create index oauth_identities_user on oauth_identities (user_id);

-- A signed-in browser on the web UI (§3, §13.1). The cookie holds a random
-- token and this table holds only its SHA-256, so a copy of the table opens
-- no web session.
create table web_sessions (
  id          bigint      generated always as identity primary key,
  uuid        uuid        not null default gen_random_uuid() unique,
  user_id     bigint      not null references users (id) on delete cascade,
  token_hash  bytea       not null unique check (octet_length(token_hash) = 32),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index web_sessions_user on web_sessions (user_id);

-- One authorized bridge install (§3, §8.1). Approving a bridge at /device
-- creates the row.
create table devices (
  id               bigint      generated always as identity primary key,
  uuid             uuid        not null default gen_random_uuid() unique,
  user_id          bigint      not null references users (id) on delete cascade,
  -- Shown on the Devices page, where the user can rename it (§13.2).
  name             text,
  -- `client.os` and `client.bridge_version` of the bridge's latest upload
  -- (§8.3). Null until its first upload.
  os               text,
  bridge_version   text,
  -- The oidc-provider grant behind the device's tokens (§8.1). Revoking the
  -- device revokes the grant.
  grant_id         text        unique,
  last_seen_at     timestamptz,
  -- When the device's first upload was stored. The free-tier device limit
  -- (§8.3, §14) reads it: the first device to upload holds the user's upload
  -- slot until it is revoked.
  first_upload_at  timestamptz,
  -- When the user revoked the device. The row stays, so its uploads keep
  -- their device.
  revoked_at       timestamptz,
  created_at       timestamptz not null default now()
);

create index devices_user on devices (user_id);

-- One row per kit the user has enabled (§13.2, Games page).
create table user_games (
  id          bigint      generated always as identity primary key,
  uuid        uuid        not null default gen_random_uuid() unique,
  user_id     bigint      not null references users (id) on delete cascade,
  -- The manifest's `kit`, e.g. `wow` (§6.1).
  kit         text        not null,
  created_at  timestamptz not null default now(),
  constraint user_games_user_kit unique (user_id, kit)
);

-- The raw bytes of one source instance as received (§3, §8.3). Kept with
-- the kit version and adapter schema so that an improved interpreter can
-- parse them again. A failed parse keeps the row with its error (§11).
create table uploads (
  id              bigint      generated always as identity primary key,
  uuid            uuid        not null default gen_random_uuid() unique,
  user_id         bigint      not null references users (id) on delete cascade,
  -- No cascade: a device row is deleted only with its user, whose delete
  -- removes the uploads in the same statement.
  device_id       bigint      not null references devices (id),
  kit             text        not null,
  source_id       text        not null,
  -- SHA-256 of the instance path relative to the kit root, in hex (§8.3).
  instance        text        not null check (instance ~ '^[0-9a-f]{64}$'),
  -- SHA-256 of the uncompressed bytes, in hex (§8.3).
  sha256          text        not null check (sha256 ~ '^[0-9a-f]{64}$'),
  -- The bytes as the bridge sent them, gzip-compressed.
  content_gzip    bytea       not null,
  -- The file's modification time, from the bridge. snapshot_at falls back to
  -- it when the adapter stamped no capture time (§6.2).
  mtime           timestamptz not null,
  -- The manifest `version` of the kit that parsed the upload.
  kit_version     text        not null,
  -- Null when the parse failed before the schema was read.
  adapter_schema  integer,
  parse_status    text        not null check (parse_status in ('parsed', 'failed')),
  -- The user-facing message of a failed parse (§8.3).
  parse_error     text,
  received_at     timestamptz not null default now(),
  constraint uploads_parse_error check ((parse_status = 'failed') = (parse_error is not null))
);

create index uploads_user on uploads (user_id);
create index uploads_device on uploads (device_id);

-- The typed state parsed from one upload (§3, §6.2). Readers order by
-- snapshot_at, not insert time, because offline uploads arrive late (§11).
create table snapshots (
  id               bigint      generated always as identity primary key,
  uuid             uuid        not null default gen_random_uuid() unique,
  user_id          bigint      not null references users (id) on delete cascade,
  upload_id        bigint      not null unique references uploads (id) on delete cascade,
  kit              text        not null,
  flavor           text        not null,
  -- E.g. {hardcore}; empty on normal realms (§6.3.1).
  rules            text[]      not null,
  -- `Parsed.character` (§6.2): the key (the WoW player GUID), the name, and
  -- the realm. All three are null when the state names no character.
  character_key    text,
  character_name   text,
  character_realm  text,
  -- When the game captured the state (§3).
  snapshot_at      timestamptz not null,
  state            jsonb       not null,
  created_at       timestamptz not null default now(),
  constraint snapshots_character check (
    (character_key is null) = (character_name is null)
    and (character_key is null) = (character_realm is null)
  )
);

create index snapshots_user_kit_recent
  on snapshots (user_id, kit, snapshot_at desc);

create index snapshots_user_kit_character_recent
  on snapshots (user_id, kit, flavor, character_key, snapshot_at desc);

commit;
