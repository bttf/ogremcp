# The self-host image of the platform (docs/architecture.md §13.3): the
# service with its web UI, the first-class kits at this commit (§6.5), and the
# migrations. docker-compose.yml at the repo root builds and runs it, and
# docs/self-host.md has the steps. To build it alone, from the repo root:
#
#   docker build -f docker/Dockerfile -t ogmcp .
#
# It is not at the repo root: Railway builds from a root Dockerfile when it
# finds one, and Railpack reads a root .dockerignore, while the hosted service
# builds with Railpack (§13.1). Dockerfile.dockerignore, next to this file,
# limits the build context.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS build
# pnpm is the version that the packageManager field of package.json names.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Every package in the lockfile, into pnpm's store. This layer changes only
# when the lockfile does.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# The platform and the workspace packages it uses, built with the Railway
# service's build command. The platform build also zips each kit's adapter/
# into platform/dist/adapters (§8.2) and writes the web UI to platform/dist/web.
COPY tsconfig.json ./
COPY packages packages
COPY kits kits
COPY platform platform
RUN pnpm install --offline --frozen-lockfile --filter "@ogmcp/platform..." \
 && pnpm --filter "@ogmcp/platform..." run build

# The platform with its production dependencies only. Each workspace package
# it depends on is copied in with the files its package.json lists.
RUN pnpm deploy --offline --legacy --prod --filter @ogmcp/platform /prod/platform

FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production \
    PORT=4790
WORKDIR /app
# Only what the service reads at run time. Root owns it, and the service runs
# as the node user, so the service cannot change it.
COPY --from=build /prod/platform/package.json /prod/platform/LICENSE platform/
COPY --from=build /prod/platform/node_modules platform/node_modules
COPY --from=build /prod/platform/dist platform/dist
COPY --from=build /prod/platform/migrations platform/migrations
USER node
EXPOSE 4790
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# The pending migrations first, as the Railway service's pre-deploy command
# applies them (§13.1). When migrate fails, the service does not start.
CMD ["sh", "-c", "node platform/dist/migrate.js && exec node platform/dist/index.js"]
