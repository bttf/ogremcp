-- 0014: the index the expired auth row cleanup reads web_sessions by (§11,
-- platform/src/auth-cleanup.ts). The job deletes the web sessions past
-- expires_at. oidc_models has its index on expires_at from 0003. This file
-- deletes nothing.
--
-- Creating an index rewrites no rows. It blocks writes to web_sessions while
-- it builds, which is brief: the table holds one row per signed-in browser.
--
-- One transaction: a failure in any statement leaves nothing behind.

begin;

create index web_sessions_expires_at on web_sessions (expires_at);

commit;
