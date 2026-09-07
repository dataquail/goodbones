import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { check, cli, fingerprintsOf } from "../cli.js";
import { typescript } from "../profile.js";
import {
  arbTree,
  parameters,
  PROPERTY_TIMEOUT,
  repoOf,
  tick,
  tightManifest,
} from "./generators.js";

// The baseline round trip: for any set of violations, `baseline` then `check`
// is ok, every entry is marked baselined, and nothing is stale.

describe("baseline round trip", () => {
  it(
    "baseline then check is ok with every finding carried and no entry stale",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbTree(typescript), async (tree) => {
          await tick();
          const repo = repoOf(tree);
          try {
            repo.writeManifest({
              ...tightManifest(repo.profile),
              baseline: ".architecture-baseline.json",
            });
            const before = check(repo, ["src"]);
            expect(before.json.unresolved, before.stderr).toEqual([]);

            const wrote = cli(repo, ["baseline", "src"]);
            expect(wrote.code, wrote.stderr).toBe(0);
            const written = JSON.parse(repo.read(".architecture-baseline.json")) as {
              readonly entries: ReadonlyArray<string>;
            };
            expect([...written.entries].sort()).toEqual([...new Set(fingerprintsOf(before.json))]);

            const after = check(repo, ["src"]);
            expect(after.code, after.stderr).toBe(0);
            expect(after.json.ok).toBe(true);
            expect(after.json.stale).toEqual([]);
            expect(fingerprintsOf(after.json)).toEqual(fingerprintsOf(before.json));
            expect(after.json.violations.every((one) => one.baselined)).toBe(true);
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
