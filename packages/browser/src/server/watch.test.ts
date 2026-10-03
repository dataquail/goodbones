import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { isRelevant, watchRepository } from "./watch.js";

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

// A commit changes no file the walk sees. Git moves `HEAD` and the index by
// renaming a lock file over them, which is what this does.
describe("watchRepository", () => {
  it(
    "reports a file it was asked to watch as well, replaced the way git replaces one",
    {
      timeout: 30_000,
    },
    async () => {
      const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "goodbones-watch-")));
      const index = path.join(scratch, "index");
      writeFileSync(index, "one");
      writeFileSync(path.join(scratch, "ORIG_HEAD"), "x");
      const seen: Array<ReadonlyArray<string>> = [];
      const stop = watchRepository({
        repoRoot: scratch,
        extensions: [".ts"],
        ledgerDir: ".architecture-campaigns",
        also: [index],
        debounceMs: 20,
        onChange: (files) => {
          seen.push(files);
        },
      });
      try {
        // A watcher takes a moment to start, and a change made before it has
        // is not reported. So the replacement is made again until one is
        // seen, as a second commit would be.
        await expect
          .poll(
            () => {
              // A neighbour it was not asked about says nothing.
              writeFileSync(path.join(scratch, "ORIG_HEAD"), "y");
              writeFileSync(path.join(scratch, "index.lock"), "two");
              renameSync(path.join(scratch, "index.lock"), index);
              return seen.flat();
            },
            { timeout: 20_000, interval: 100 },
          )
          .toEqual(expect.arrayContaining([index]));
        expect(seen.flat().every((file) => file === index)).toBe(true);
      } finally {
        stop();
        rmSync(scratch, { force: true, recursive: true });
      }
    },
  );
});
