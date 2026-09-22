import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Persist transformed modules between runs — re-transformation dominated
    // the wall time of the full suite.
    fsModuleCache: true,
  },
});