# Self-host

Spec: §13.3 of [`architecture.md`](architecture.md).

Docker Compose runs the platform (web UI, MCP server, bridge API, OAuth
server) and its Postgres. The platform runs the first-class kits in `kits/` at
the commit it was built from (§6.5). It has no way to load other kits.

## Prerequisites

- Docker Engine 23 or later, or Docker Desktop, with Compose v2
  (`docker compose`). The build needs BuildKit, the default builder since
  Engine 23.
- A clone of this repo. No image is published yet (`docs/releases.md`), so
  Compose builds one from `docker/Dockerfile`.
- At least one sign-in provider: a Google OAuth client of type "Web
  application", a Discord application, or both. Nobody can sign in without
  one.
- For hosted agents and for bridges on other machines: a domain with HTTPS,
  served by a reverse proxy in front of the service. Hosted agents, such as
  Claude and ChatGPT, reach the MCP URL from the internet. The bridge accepts
  `http://` only on a loopback address.
- Optional: a Firecrawl API key.

## Set up

1. Create `.env` from the template. `.env` is git-ignored.

   ```sh
   cp selfhost.env.example .env
   ```

2. Set `POSTGRES_PASSWORD` to letters and digits, such as the output of
   `openssl rand -hex 32`. Postgres reads it only when it creates the
   `ogmcp_postgres-data` volume, at the first start. To change it later, set
   it in Postgres first, then in `.env`, then run `docker compose up -d`:

   ```sh
   docker compose exec postgres psql -U ogmcp -d ogmcp -c '\password ogmcp'
   ```
3. Set `PUBLIC_BASE_URL` to the origin users reach, such as
   `https://ogmcp.example.com`. The default, `http://localhost:4790`, works
   from this machine only.
4. Set the credentials of one sign-in provider or both, and register its
   redirect URI with the provider:
   - Google: `<PUBLIC_BASE_URL>/auth/google/callback`
   - Discord: `<PUBLIC_BASE_URL>/auth/discord/callback`
5. Optional: set `FIRECRAWL_API_KEY`. Without it, `search_game_info` and
   `fetch_game_page` answer `search_unavailable`.
6. Generate the OAuth server's keys. These commands build the image and
   append `OIDC_JWKS` and `OIDC_COOKIE_KEYS` to `.env`:

   ```sh
   docker compose build
   docker compose run --rm --no-deps -T ogmcp node platform/dist/gen-oidc-keys.js >> .env
   ```

   The keys are secrets. Generate them once and keep them: new keys end every
   agent's and every bridge's sign-in. Windows PowerShell writes `>>` as
   UTF-16, so there, run the command without `>> .env` and paste the two lines
   into `.env`.

## Start

```sh
docker compose up
```

Add `-d` to run it in the background. The `ogmcp` service waits until
Postgres is healthy, applies the pending migrations, and starts. When a
migration fails, the service does not start, and `docker compose logs ogmcp`
says which file failed.

The service listens on `127.0.0.1:4790`. `GET /health` answers 200 when the
service and its database are up. Open `PUBLIC_BASE_URL` and sign in.

## Behind a reverse proxy

Terminate TLS at a reverse proxy, such as Caddy or nginx, and forward to
`127.0.0.1:4790` with the request's `Host` header unchanged. `/mcp` refuses a
`Host` that is not the host of `PUBLIC_BASE_URL`. Set these in `.env`, then
run `docker compose up -d` to apply them:

```sh
PUBLIC_BASE_URL=https://ogmcp.example.com
TRUST_PROXY_HOPS=1
```

## Connect an agent

Sign in and open **Connect your agent**. The page shows the MCP URL,
`<PUBLIC_BASE_URL>/mcp`, and the steps for Claude, Claude Code, ChatGPT, and
Perplexity.

## Point a bridge at the server

The bridge uses the hosted service until its settings name another server.
Set the server to `PUBLIC_BASE_URL`: an origin with `https://`, or `http://`
on a loopback address. The bridge saves it in its settings file,
`ogmcp-bridge/config.json` in the user's config folder, as `server_url`. The
setting lasts across restarts and applies when the bridge starts at login.

- macOS and Windows: open the bridge's menu, choose **Server…**, enter the
  URL, and confirm. An empty entry goes back to the hosted service.
- macOS, from a shell: quit the bridge, then run

  ```sh
  "/Applications/Open Gamer MCP.app/Contents/MacOS/ogmcp-bridge" server set https://ogmcp.example.com
  ```

  `server reset` goes back to the hosted service, and `server` alone prints
  the server in use.

The bridge keeps a separate login for each server, in the keychain. A change
stops the uploads to the old server and starts the bridge again against the
new one. If the bridge holds no login for the new server, its menu shows
**Log in…**. The login for the old server stays, so changing back needs no new
login.

`OGMCP_BASE_URL`, when set, overrides the setting. It is for development:
the start-at-login item on macOS does not see it.

The Get started page links to the bridge download when `BRIDGE_DOWNLOAD_URL`
is set in `.env`.

## Other settings

Every line of `.env` reaches the service. `platform/.env.example` describes
each setting. Any of them may go in `.env`, except `DATABASE_URL` and `PORT`,
which `docker-compose.yml` sets.

## Update

```sh
git pull
docker compose up -d --build
```

The pending migrations apply when the service starts.

## Data

Postgres keeps its data in the `ogmcp_postgres-data` volume.
`docker compose down` keeps the volume, and `docker compose down -v` deletes
it. `docker-compose.yml` pins Postgres 18. A new major version cannot read the
volume: moving to one takes `pg_dump` and a restore.
