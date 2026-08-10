import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      globals: true,
      environment: "node",
    },
    include: ["packages/*/test/**/*.test.ts"],
  },
]);
