import express, { type Router } from "express";

/** Longest wait for the database check before `/health` says degraded. */
export const HEALTH_DB_TIMEOUT_MS = 2_000;

export interface HealthOptions {
  /** Resolves when the database answers. */
  checkDatabase: () => Promise<unknown>;
  /** Default: `HEALTH_DB_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * `GET /health/live` answers 200 while the process serves requests and never
 * touches the database. Railway's deploy healthcheck uses it.
 *
 * `GET /health` also checks the database: 200 `ok` when it answered within
 * the timeout, 503 `degraded` when it failed or was slow. The body never says
 * why.
 *
 * At most one database check runs at a time. A request that arrives while one
 * runs waits for that one, so a flood of `/health` holds one connection.
 */
export function healthRouter({ checkDatabase, timeoutMs = HEALTH_DB_TIMEOUT_MS }: HealthOptions): Router {
  const router = express.Router();
  let running: Promise<boolean> | null = null;

  const probe = (): Promise<boolean> => {
    running ??= checkDatabase()
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        running = null;
      });
    return running;
  };

  const databaseOk = async (): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>((done) => {
      timer = setTimeout(() => done(false), timeoutMs);
    });
    try {
      return await Promise.race([probe(), late]);
    } finally {
      clearTimeout(timer);
    }
  };

  router.get("/health/live", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ status: "ok" });
  });

  router.get("/health", async (_req, res) => {
    const ok = await databaseOk();
    res.set("Cache-Control", "no-store");
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded" });
  });

  return router;
}
