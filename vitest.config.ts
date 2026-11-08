import { defineConfig } from "vitest/config";

// Configuration séparée de vite.config.ts, dont la racine est web/.
export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
