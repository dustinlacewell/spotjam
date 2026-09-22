import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Persist transformed modules between runs (see docs/development/scoped-testing.md).
    fsModuleCache: true,
  },
});