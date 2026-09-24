# Open Gamer MCP

Open Gamer MCP (`ogmcp`) connects a video game to any AI agent through one
remote MCP server. A kit per game reads live game state; the agent uses it to
give spoiler-free, friend-style guidance. The first kit is WoW, starting with
Classic Era.

## Source of truth

`docs/architecture.md` is the source of truth. If code and the doc disagree,
raise it. Do not silently diverge.

Rules from §0:

- Cite the § in every issue and PR.
- On a `[decide]`, a gap, or a contradiction: stop and ask. Do not choose
  silently.
- Build nothing tagged `[later]` or `[policy]`, nothing in §17, and no
  speculative abstractions (§2).
- Values marked *proposed* (limits, TTLs, sizes) are config, not constants.
- Build order and dependencies are in §18.

Tracker: Linear project **Open Gamer MCP**,
https://linear.app/redpinesoftware/project/open-gamer-mcp-f052b560decb
(workspace `redpinesoftware`, team `RED`). Always pass `-w redpinesoftware` to
the `linear` CLI. The Linear MCP connector is bound to a different workspace and
cannot see this one.

## Repo layout (§5)

| Path | Contents | License |
|---|---|---|
| `packages/sdk/` | `@ogmcp/sdk`. Manifest schema, `Interpreter` interface, shared types. Depends on nothing. | MIT |
| `kits/wow/` | `@ogmcp/kit-wow`. `adapter/` (Lua addon), `interpreter/` (TS), `manifest.json`, `fixtures/`. Depends on `@ogmcp/sdk` only. | MIT |
| `platform/` | `@ogmcp/platform`. Node service: web UI, MCP server, bridge API, OAuth server. Depends on `@ogmcp/sdk`, and on kits only through the `Interpreter` interface. | AGPL-3.0-or-later |
| `bridge/` | Go module `github.com/bttf/ogmcp/bridge`. Knows only manifest JSON and the HTTP API. | MIT |
| `docs/` | `architecture.md` and process docs. | MIT |

`packages/sdk`, `kits/wow`, and `platform` are pnpm workspace packages.
`bridge/` is a standalone Go module. Files outside the four package paths are
MIT (root `LICENSE`).

## Stack decisions (D1, §13.1)

- Node 24, TypeScript, pnpm 10 workspaces, Vitest for tests.
- Platform: Express 5, raw `pg`, numbered SQL migrations applied by an in-repo
  runner, and a Vite + React 19 + react-router single-page app served by the
  platform service. One Node service plus Postgres on Railway.
- No Supabase.
- Schema changes are numbered SQL migrations in `platform/`. Never apply DDL to
  a live database yourself; escalate it to the user.
- Go 1.22 for the bridge.

## Deploy (§5, §13.1)

Railway project `ogmcp`, environment `production`:

- Service `ogmcp`: the platform, built with Railpack from `bttf/ogmcp`, branch
  `main`. Domain: `ogmcp-production.up.railway.app` (the default Railway
  domain).
- Service `Postgres`: Railway Postgres. The `ogmcp` service's `DATABASE_URL`
  is the reference `${{Postgres.DATABASE_URL}}`, which connects over the
  private network.

The service settings live on the service, not in a config file in the repo.
Change them with `railway api` and the `serviceInstanceUpdate` mutation.

| Setting | Value |
|---|---|
| Build command | `pnpm --filter @ogmcp/platform... run build` |
| Start command | `node platform/dist/index.js` |
| Healthcheck path | `/health/live` |
| Watch paths | `/platform/**`, `/packages/sdk/**`, `/kits/**`, `/package.json`, `/pnpm-lock.yaml`, `/pnpm-workspace.yaml`, `/tsconfig.json` |
| Variables | `DATABASE_URL` (the reference above), `RAILPACK_NODE_VERSION=24` |

A push to `main` deploys only when a changed file matches a watch path, so a
bridge-only change skips the deploy. A new root workspace file, such as
`.npmrc`, needs its own watch path.

`GET /health/live` answers while the process runs and never touches the
database. `GET /health` also checks the database and answers 503 when it is
unreachable.

## Commands

- `pnpm install`
- `pnpm build`, `pnpm typecheck`, `pnpm test`: every TS package.
- `pnpm test:bridge`: `go vet` and `go test` in `bridge/`.
- `pnpm --filter @ogmcp/platform start`: run the built platform. It reads
  `platform/.env` when it exists; `platform/.env.example` lists the names.

## In-game testing

In-game checks run in WoW Classic Era only. Disable the WoWGuide addon while
testing OpenGamerMCP, because both register `/transmit`.

## Commits

Every commit is signed off for the DCO: use `git commit -s`. CI fails a PR if
any of its commits lacks a `Signed-off-by:` trailer.

## Security

The repo is **private for now and goes public at P9** (§5). Write every commit
as though it were already public: no secret ever enters the repo, not in code,
tests, fixtures, commit messages, or issue links. Secrets live in Railway env
vars and in git-ignored local `.env` files. History is not rewritten before
publication, so a leaked credential stays leaked.

Going public is a release gate: Blizzard requires addon code to be public
before distribution, so the whole repo goes public at the P9 listings. §20 and
anything else private is removed first.

CI runs gitleaks over the full history on every PR. `.gitleaks.toml` allowlists
confirmed false positives only.

## How work gets done

See `docs/PROCESS.md`. It is not optional; follow it for every unit of work.
