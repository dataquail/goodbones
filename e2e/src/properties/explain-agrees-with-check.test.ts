import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { check, cli } from "../cli.js";
import { typescript } from "../profile.js";
import {
  arbTree,
  parameters,
  PROPERTY_TIMEOUT,
  repoOf,
  tick,
  tightManifest,
} from "./generators.js";

// Explain agrees with check: for every file check reported on, `explain`
// names the rule that reported it. Capped at a few files per tree, since
// each is a Node start.

const EXPLAINED_PER_TREE = 3;

describe("explain agrees with check", () => {
  it(
    "explain names every rule check reported for a file",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbTree(typescript), async (tree) => {
          await tick();
          const repo = repoOf(tree);
          try {
            repo.writeManifest(tightManifest(repo.profile));
            const { json, stderr } = check(repo, ["src"]);
            expect(json.unresolved, stderr).toEqual([]);

            const byFile = new Map<string, Set<string>>();
            for (const one of json.violations) {
              byFile.set(one.file, (byFile.get(one.file) ?? new Set()).add(one.ruleName));
            }
            for (const [file, rules] of [...byFile].slice(0, EXPLAINED_PER_TREE)) {
              const explained = cli(repo, ["explain", file]);
              expect(explained.code, explained.stderr).toBe(0);
              for (const rule of rules) expect(explained.stdout, file).toContain(rule);
            }
          } finally {
            repo.dispose();
          }
        }),
        parameters(),
      );
    },
    PROPERTY_TIMEOUT,
  );
});
