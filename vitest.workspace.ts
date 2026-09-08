import { defineWorkspace } from "vitest/config";

// Workspaces are listed explicitly rather than globbed, so a new directory under
// `packages/` has to opt in to the root test run.
export default defineWorkspace([
  "packages/core",
  "packages/typescript",
  "packages/explorer",
  "packages/cli",
  "packages/oxlint",
]);
