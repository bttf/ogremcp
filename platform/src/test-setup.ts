import { configureLogger } from "./log.js";

// The app writes an access line per request. A test that checks the lines
// takes them with its own `configureLogger`.
configureLogger({ write: () => {} });
