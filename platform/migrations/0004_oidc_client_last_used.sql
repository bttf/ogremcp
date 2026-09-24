-- 0004: when a registered OAuth client last got a token (§9).
--
-- Dynamic client registration stores each client as a `Client` row of
-- oidc_models. last_used_at is set on that row each time the token endpoint
-- issues the client a token. A client that has not got one for
-- OAUTH_CLIENT_UNUSED_DAYS, counted from its registration when it never has,
-- is deleted by the cleanup job (platform/src/oidc-registration.ts). Rows of
-- every other model leave it null.
--
-- A nullable column without a default rewrites no rows.
--
-- One transaction: a failure in any statement leaves nothing behind.

begin;

alter table oidc_models add column last_used_at timestamptz;

commit;
