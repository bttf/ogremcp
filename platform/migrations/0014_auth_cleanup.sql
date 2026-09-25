-- 0014: what the expired auth row cleanup needs (§11,
-- platform/src/auth-cleanup.ts). The job deletes oidc_models rows past
-- expires_at, access tokens included, and the web sessions past expires_at.
-- This file deletes nothing.
--
-- - web_sessions_expires_at: the job reads web_sessions by expires_at.
--   oidc_models has its index on expires_at from 0003.
-- - A Grant row's last_used_at: when the token endpoint last issued the
--   grant a token (platform/src/oidc-registration.ts). The Connected agents
--   page shows it (platform/src/agents.ts). Before this, the page read the
--   newest access token's iat, and the job deletes expired access tokens.
--   Here each existing grant gets its newest access token's iat, so the page
--   shows the same time. A grant with no access token row keeps null until
--   its next token. Only Grant rows whose last_used_at is null change, and
--   nothing read that column on them before.
--
-- Creating an index rewrites no rows. It blocks writes to web_sessions while
-- it builds, which is brief: the table holds one row per signed-in browser.
--
-- One transaction: a failure in any statement leaves nothing behind.

begin;

create index web_sessions_expires_at on web_sessions (expires_at);

update oidc_models g
   set last_used_at = t.last_iat
  from (
    select grant_id, to_timestamp(max((payload->>'iat')::double precision)) as last_iat
      from oidc_models
     where model = 'AccessToken'
       and grant_id is not null
       and jsonb_typeof(payload->'iat') = 'number'
     group by grant_id
  ) t
 where g.model = 'Grant'
   and g.oidc_id = t.grant_id
   and g.last_used_at is null;

commit;
