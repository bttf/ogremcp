import express, { type Express } from "express";

import { type HealthOptions, healthRouter } from "./health.js";

/** The Express app. `index.ts` gives it the database check and serves it. */
export function createApp(health: HealthOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(healthRouter(health));
  return app;
}
