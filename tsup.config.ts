import { defineConfig } from "tsup";

// Shared tsup config for every node package's `build` script (Task 4 of the
// cleanup wave — see docs/superpowers/specs/2026-08-11-cleanup-wave-design.md
// decision 6). Transpile-only, one-output-file-per-source-file (bundle:
// false) so relative imports between a package's own files keep resolving
// exactly like they do today at the source level (source already writes
// NodeNext-style extensionful relative imports, e.g. `from "./fleet.js"`,
// so the compiled output's identical relative specifiers resolve against
// the mirrored dist/ tree with zero rewriting needed). No dts emission
// (deferred — tsc --noEmit remains the typecheck gate). Each package invokes
// this via `tsup --config ../../tsup.config.ts`, executed with its own
// package directory as cwd, so the `src/**/*.ts` entry glob picks up that
// package's own sources.
export default defineConfig({
  entry: ["src/**/*.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: false,
  splitting: false,
  dts: false,
  sourcemap: false,
  clean: true,
});
