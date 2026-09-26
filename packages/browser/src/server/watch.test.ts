import { describe, expect, it } from "vitest";

import { isRelevant } from "./watch.js";

// Which changes redraw: source of the policy's languages, any manifest, the
// ledgers — and nothing under a directory the walk never enters.

describe("isRelevant", () => {
  const extensions = [".ts", ".tsx"];
  const ledgerDir = ".architecture-campaigns";

  it("takes source files by extension", () => {
    expect(isRelevant("packages/core/src/index.ts", extensions, ledgerDir)).toBe(true);
    expect(isRelevant("packages/app/x.tsx", extensions, ledgerDir)).toBe(true);
    expect(isRelevant("README.md", extensions, ledgerDir)).toBe(false);
    expect(isRelevant("packages/core/src/index.go", extensions, ledgerDir)).toBe(false);
  });

  it("takes every manifest file, root or included, in any form", () => {
    expect(isRelevant("architecture.yaml", extensions, ledgerDir)).toBe(true);
    expect(isRelevant("packages/core/architecture.yaml", extensions, ledgerDir)).toBe(true);
    expect(isRelevant("architecture.json", extensions, ledgerDir)).toBe(true);
    expect(isRelevant("architecture.config.mjs", extensions, ledgerDir)).toBe(true);
    expect(isRelevant("other.yaml", extensions, ledgerDir)).toBe(false);
  });

  it("takes the ledgers", () => {
    expect(isRelevant(".architecture-campaigns/x/y.json", extensions, ledgerDir)).toBe(true);
    expect(isRelevant(".architecture-campaigns", extensions, ledgerDir)).toBe(true);
    expect(isRelevant(".architecture-baseline.json", extensions, ledgerDir)).toBe(false);
  });

  it("ignores what the walk never enters", () => {
    expect(isRelevant("node_modules/x/index.ts", extensions, ledgerDir)).toBe(false);
    expect(isRelevant("packages/core/build/esm/index.ts", extensions, ledgerDir)).toBe(false);
    expect(isRelevant(".git/index.ts", extensions, ledgerDir)).toBe(false);
  });
});
