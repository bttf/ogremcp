-- 0003: the OAuth tables of §11: what oidc-provider persists (§9, §13.1).
--
-- One table holds every oidc-provider model: clients, grants, sessions,
-- interactions, authorization codes, access and refresh tokens, device codes,
-- and the rest. The adapter is platform/src/oidc-adapter.ts. A row is one
-- stored model, keyed by the model name and oidc-provider's own id for it.
-- payload is what oidc-provider stored, as it stored it.
--
-- The serial id and the uuid follow §11. oidc-provider never sees them; it
-- looks rows up by (model, oidc_id) and by the three lookup columns, which the
-- adapter copies out of the payload on every write.
--
-- Rows past expires_at are never returned. Nothing deletes them yet: a cleanup
-- job comes later, and expires_at is indexed for it. A client has no expiry.
--
-- One transaction: a failure in any statement leaves nothing behind.

begin;

create table oidc_models (
  id          bigint      generated always as identity primary key,
  uuid        uuid        not null default gen_random_uuid() unique,
  -- oidc-provider's model name, e.g. `Session`, `AccessToken`, `Client`.
  model       text        not null,
  -- oidc-provider's id of the row within its model: a token's jti, a
  -- client's client_id, a session's id.
  oidc_id     text        not null,
  payload     jsonb       not null,
  -- payload.grantId: the grant a token, code, or interaction belongs to.
  -- Revoking a grant deletes its tokens and codes by it.
  grant_id    text,
  -- payload.userCode: a device code's user code (§8.1).
  user_code   text,
  -- payload.uid: a session's uid.
  uid         text,
  -- Null when the row does not expire.
  expires_at  timestamptz,
  constraint oidc_models_model_oidc_id unique (model, oidc_id)
);

create index oidc_models_grant on oidc_models (model, grant_id) where grant_id is not null;
create index oidc_models_user_code on oidc_models (model, user_code) where user_code is not null;
create index oidc_models_uid on oidc_models (model, uid) where uid is not null;
create index oidc_models_expires_at on oidc_models (expires_at) where expires_at is not null;

commit;
