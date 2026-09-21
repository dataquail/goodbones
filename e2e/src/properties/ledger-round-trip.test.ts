import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { check, cli } from "../cli.js";
import { typescript } from "../profile.js";
import {
  arbTree,
  campaignManifest,
  parameters,
  PROPERTY_TIMEOUT,
  repoOf,
  tick,
} from "./generators.js";

// The ledger round trip: for any tree, `objectives clear` then `check` is ok
// with every hit ledgered; `clear` with nothing fixed changes nothing; and
// after a file that hit is deleted, `check` fails on the stale holdout
// until `clear` reproduces exactly the entries the hits now spell — under
// the implicit sector, whose root is the repository.

type Ledger = {
  readonly sectors: Readonly<
    Record<
      string,
      {
        readonly initial: number;
        readonly cleared: number;
        readonly holdouts: ReadonlyArray<string>;
      }
    >
  >;
};

const CAMPAIGNS: ReadonlyArray<readonly [string, string]> = [
  ["handlers-and-services", "behind-the-bus"],
  ["no-literal-ones", "literal-one"],
];

const entryOf = (one: { readonly file: string; readonly subject: string | null }): string =>
  one.subject === null ? one.file : `${one.file}#${one.subject}`;

// A tree with at least one handler or service, so the deletion step has a
// file to delete.
const arbTreeWithHit = () =>
  arbTree(typescript).filter((tree) =>
    tree.files.some((file) => /\/(handler|service)\.ts$/.test(file)),
  );

describe("ledger round trip", () => {
  it(
    "clear then check is ok with every hit ledgered, and clear reproduces the entries",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbTreeWithHit(), async (tree) => {
          await tick();
          const repo = repoOf(tree);
          try {
            repo.writeManifest(campaignManifest(repo.profile));
            const before = check(repo, ["src"]);
            expect(before.json.unresolved, before.stderr).toEqual([]);
            const hitsOf = (json: typeof before.json, id: string, objective: string) =>
              json.violations
                .filter((one) => one.ruleName === `campaign/${id}/${objective}`)
                .map(entryOf)
                .sort();
            const written = (id: string, objective: string) => {
              const ledger = JSON.parse(
                repo.read(`.architecture-campaigns/${id}/${objective}.json`),
              ) as Ledger;
              const scope = ledger.sectors.scope;
              if (scope === undefined) throw new Error("no implicit sector in the ledger");
              return scope;
            };

            const cleared = cli(repo, ["objectives", "clear", "src"]);
            expect(cleared.code, cleared.stderr).toBe(0);
            for (const [id, objective] of CAMPAIGNS) {
              expect(written(id, objective).holdouts).toEqual([
                ...new Set(hitsOf(before.json, id, objective)),
              ]);
              expect(written(id, objective).initial).toBe(written(id, objective).holdouts.length);
            }

            const after = check(repo, ["src"]);
            expect(
              after.json.campaigns.every((one) => one.new.length === 0 && one.stale.length === 0),
            ).toBe(true);
            expect(
              after.json.violations
                .filter((one) => one.kind === "campaign")
                .every((one) => one.ledgered),
            ).toBe(true);

            // Nothing fixed: clear is a no-op, and says so.
            const idle = cli(repo, ["objectives", "clear", "src"]);
            expect(idle.code, idle.stderr).toBe(0);
            expect(idle.stdout).toContain("nothing to clear");

            // A file that hit both campaigns is deleted: both ledgers are
            // stale, check fails, and clear reproduces the hits.
            const victim = tree.files.find((file) => /\/(handler|service)\.ts$/.test(file));
            if (victim === undefined) return;
            repo.remove(victim);
            const stale = check(repo, ["src"]);
            expect(stale.code).toBe(1);
            expect(stale.json.campaigns.map((one) => one.stale.length > 0)).toEqual([true, true]);

            const recleared = cli(repo, ["objectives", "clear", "src"]);
            expect(recleared.code, recleared.stderr).toBe(0);
            const settled = check(repo, ["src"]);
            expect(
              settled.json.campaigns.every((one) => one.new.length === 0 && one.stale.length === 0),
            ).toBe(true);
            for (const [id, objective] of CAMPAIGNS) {
              const scope = written(id, objective);
              expect(scope.holdouts).toEqual([...new Set(hitsOf(settled.json, id, objective))]);
              expect(scope.cleared).toBeGreaterThan(0);
              expect(scope.initial - scope.cleared).toBe(scope.holdouts.length);
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
