import { defineConfig } from "vite";

/**
 * The web UI (§13.2). `pnpm build` writes it to `platform/dist/web`, which
 * the platform service serves (`src/web.ts`).
 *
 * `pnpm --filter @ogmcp/platform dev:web` runs the Vite dev server, which
 * sends the service's paths to a platform started on its default port. Set
 * the platform's `PUBLIC_BASE_URL` to the dev server's origin, so that
 * sign-in returns to it and sign-out passes the `Origin` check.
 */
const PLATFORM = "http://localhost:4790";

export default defineConfig({
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        // react-router marks its modules "use client" for React Server
        // Components. This app has none, and the bundler drops the marker.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
  server: {
    proxy: {
      "/api": PLATFORM,
      "/auth": PLATFORM,
      "/health": PLATFORM,
      "/interaction": PLATFORM,
      "/oauth": PLATFORM,
      // `/device` and `/device/:uid`, not `/devices`. A page load of `/device`
      // is this server's page; its calls and form posts are the platform's.
      "^/device(?:[/?]|$)": {
        target: PLATFORM,
        bypass: (req) => (req.method === "GET" && req.url?.split("?")[0] === "/device" && req.headers.accept?.includes("text/html") ? req.url : undefined),
      },
    },
  },
});
