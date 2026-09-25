import { defineConfig } from "vitest/config";

// Tests write no log lines unless they take them (`src/test-setup.ts`).
export default defineConfig({ test: { setupFiles: ["./src/test-setup.ts"] } });
