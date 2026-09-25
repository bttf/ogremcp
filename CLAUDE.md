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

## Package seams (§5)

CI enforces the dependency rules in the table above. `pnpm lint:seams` runs the
TypeScript checks (`scripts/lint-seams.mjs`). Run `pnpm build` first, as CI
does, so that every import resolves.

- A `package.json` may declare only the workspace dependencies §5 allows, each
  as `workspace:*`, `workspace:^`, or `workspace:~`. Aliases and `link:` or
  `file:` specs into the repo fail.
- dependency-cruiser (`.dependency-cruiser.cjs`, run with each package's
  tsconfig) fails any other cross-package import. That includes a relative
  import or an alias (tsconfig `paths`, package.json `imports`) that leaves its
  own package, and any import that does not resolve.
- In `platform`, only the kit registry, `platform/src/kits/registry.ts`, may
  import `@ogmcp/kit-*`, and it may not re-export a kit. It imports a kit's
  exports by name: no `import * as`, and a default import only of a kit's JSON
  file. If the path changes, change `KIT_REGISTRY` in
  `.dependency-cruiser.cjs` and `scripts/lint-seams.mjs` too.
- The CI `bridge` job fails if the bridge builds from Go code in the repo
  outside `bridge/`.
- The lint cannot see a specifier built at runtime, such as
  `` import(`@ogmcp/kit-${name}`) ``, `import(name)`, or a `createRequire`
  call. Reviewers check for these by hand.

## Stack decisions (D1, §13.1)

- Node 24, TypeScript, pnpm 10 workspaces, Vitest for tests.
- Platform: Express 5, raw `pg`, numbered SQL migrations applied by an in-repo
  runner, and a Vite + React 19 + react-router single-page app served by the
  platform service. One Node service plus Postgres on Railway.
- No Supabase.
- Schema changes are numbered SQL migrations in `platform/migrations/`,
  applied by the runner in `platform/src/migrations.ts`. Migrations apply on
  deploy through the `ogmcp` service's pre-deploy command. Agents never run DDL
  against a live database by hand. A migration that drops or rewrites data
  needs the owner's approval before merge.
- Go 1.27 for the bridge (`bridge/go.mod`).

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
| Pre-deploy command | `node platform/dist/migrate.js` |
| Start command | `node platform/dist/index.js` |
| Healthcheck path | `/health/live` |
| Watch paths | `/platform/**`, `/packages/sdk/**`, `/kits/**`, `/package.json`, `/pnpm-lock.yaml`, `/pnpm-workspace.yaml`, `/tsconfig.json` |
| Variables | `DATABASE_URL` (the reference above), `RAILPACK_NODE_VERSION=24` |

The pre-deploy command applies the pending migrations before the new version
starts. When it fails, the deploy stops and the previous version keeps serving.

A push to `main` deploys only when a changed file matches a watch path, so a
bridge-only change skips the deploy. A new root workspace file, such as
`.npmrc`, needs its own watch path.

`GET /health/live` answers while the process runs and never touches the
database. `GET /health` also checks the database and answers 503 when it is
unreachable.

## Commands

- `pnpm install`
- `pnpm build`, `pnpm typecheck`, `pnpm test`: every TS package. The platform
  build also zips each kit's `adapter/` into `platform/dist/adapters` (§8.2);
  the platform does not start without those zips.
- `pnpm test:bridge`: `go vet` and `go test` in `bridge/`.
- `make -C bridge dist`: unsigned dev builds of the bridge in `bridge/dist/`:
  the Windows binary and the macOS universal binary as a zipped `.app`. Needs
  GoReleaser v2 and macOS (`docs/releases.md`).
- `pnpm lint:seams`: the package seam checks (§5).
- `pnpm --filter @ogmcp/platform dev:web`: Vite dev server for the web UI.
  The service serves `platform/dist/web`, which the platform build produces.
- `pnpm --filter @ogmcp/platform start`: run the built platform. It reads
  `platform/.env` when it exists; `platform/.env.example` lists the names.
- `pnpm --filter @ogmcp/platform migrate [--dry-run]`: after a build, apply the
  pending migrations to `DATABASE_URL`, or only list them. For a local
  database; production migrates on deploy.
- `pnpm --filter @ogmcp/platform reparse [--dry-run]`: after a build, re-parse
  the stored uploads of `DATABASE_URL` with the current kits (§11); options
  in `platform/src/reparse.ts`. Not part of the deploy.
- `pnpm -s --filter @ogmcp/platform gen-oidc-keys`: after a build, print fresh
  values for `OIDC_JWKS` and `OIDC_COOKIE_KEYS`, the OAuth server's keys, as
  `KEY=value` lines for Railway or `platform/.env`. They are secrets. `-s`
  keeps pnpm's own lines out of the output.
- Platform tests that apply migrations need `TEST_DATABASE_URL`: a Postgres
  server whose user may create databases. Without it they are skipped.

## In-game testing

In-game checks run in WoW Classic Era only. Disable the WoWGuide addon while
testing OpenGamerMCP, because both register `/transmit`.

## Commits

Every commit is signed off for the DCO: use `git commit -s`. CI fails a PR if
any of its commits lacks a `Signed-off-by:` trailer that matches the commit
author's name and email.

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
