import { defineConfig } from "vitest/config";

// Projects are listed explicitly rather than globbed, so a new directory under
// `packages/` has to opt in to the root test run.
export default defineConfig({
  test: {
    projects: [
      "packages/core",
      "packages/typescript",
      "packages/ast-grep",
      "packages/campaigns",
      "packages/cli",
      "packages/oxlint",
      "packages/browser",
    ],
  },
});
