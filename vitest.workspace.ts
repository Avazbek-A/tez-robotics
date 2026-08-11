import { defineWorkspace } from "vitest/config";

// Packages with their own vitest.config.ts (dashboard needs happy-dom,
// api/persistence set custom options) are picked up via the glob; the
// inline entry covers the plain node packages without a config file.
export default defineWorkspace([
  "packages/*/vitest.config.ts",
  {
    test: {
      globals: true,
      environment: "node",
      include: ["packages/*/test/**/*.test.ts"],
      exclude: [
        "packages/api/**",
        "packages/dashboard/**",
        "packages/persistence/**",
        "**/node_modules/**",
      ],
    },
  },
]);
