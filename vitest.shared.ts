import * as path from "node:path";
import { type ViteUserConfig } from "vitest/config";

// A package's tests import its workspace siblings by their published names
// (`@goodbones/core`), the same specifiers a consumer writes. In a test run those
// point at the sibling's `src`, so one edit is visible everywhere without a build.
// `TEST_DIST=1` points them at the built output instead, so the suite can be
// re-run against what `tsc -b tsconfig.build.json` actually emitted. Note that
// `nx run-many -t test` does not key its cache on `TEST_DIST`, so going through
// Nx will replay the `src` run — invoke vitest directly in a package to actually
// exercise `build/esm`.
const entry = (dir: string, file: string) =>
  path.join(
    __dirname,
    "packages",
    dir,
    process.env.TEST_DIST !== undefined ? `build/esm/${file}.js` : `src/${file}.ts`,
  );

const config: ViteUserConfig = {
  esbuild: {
    target: "es2020",
  },
  test: {
    onConsoleLog: (log) => {
      console.log(log);
    },
    setupFiles: [path.join(__dirname, "setupTests.ts")],
    fakeTimers: {
      toFake: undefined,
    },
    sequence: {
      concurrent: true,
    },
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    alias: [
      { find: /^@goodbones\/core\/testing$/, replacement: entry("core", "testing") },
      { find: /^@goodbones\/core$/, replacement: entry("core", "index") },
      { find: /^@goodbones\/typescript$/, replacement: entry("typescript", "index") },
      { find: /^@goodbones\/ast-grep$/, replacement: entry("ast-grep", "index") },
      { find: /^@goodbones\/campaigns$/, replacement: entry("campaigns", "index") },
    ],
  },
};

export default config;
