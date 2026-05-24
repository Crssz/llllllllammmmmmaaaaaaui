import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["src-tauri/**", "node_modules/**", "dist/**"],
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      reporter: ["text", "html"],
      include: ["src/lib/**/*.ts", "src/state/**/*.ts"],
      exclude: [
        "src/lib/api.ts", // thin Tauri IPC wrapper, no logic
        "src/state/effects.tsx", // React side-effects, exercised via integration only
        "src/state/index.ts", // re-exports + thin React-only hooks
        "src/state/testUtils.ts", // test helpers, not production code
        "src/state/persist.ts", // single-line fire-and-forget wrappers
        "**/*.test.ts",
        "**/*.test.tsx",
      ],
    },
  },
});
