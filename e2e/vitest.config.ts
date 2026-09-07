import { defineConfig } from "vitest/config";

// Not the shared config: nothing here aliases `@goodbones/*` to source, since
// the point of this suite is the emitted output. Each `cli()` is a Node start
// plus resolver construction, so the budget per test is generous; fixtures
// live in temp directories, so files may run in parallel.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    passWithNoTests: false,
  },
});
