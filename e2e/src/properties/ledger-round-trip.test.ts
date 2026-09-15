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

// The ledger round trip: for any tree, `campaigns init` then `check` is ok
// with every hit ledgered; `prune` with nothing fixed changes nothing; and
// after a file that hit is deleted, `check` fails on the stale entry until
// `prune` reproduces exactly the entries the hits now spell.

type Ledger = {
  readonly initial: number;
  readonly fixed: number;
  readonly lastProgress: string;
  readonly entries: ReadonlyArray<string>;
};

const CAMPAIGNS = ["handlers-and-services", "no-literal-ones"];

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
    "init then check is ok with every hit ledgered, and prune reproduces the entries",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbTreeWithHit(), async (tree) => {
          await tick();
          const repo = repoOf(tree);
          try {
            repo.writeManifest(campaignManifest(repo.profile));
            const before = check(repo, ["src"]);
            expect(before.json.unresolved, before.stderr).toEqual([]);
            const hitsOf = (json: typeof before.json, id: string) =>
              json.violations
                .filter((one) => one.ruleName === `campaign/${id}`)
                .map(entryOf)
                .sort();
            const written = (id: string): Ledger =>
              JSON.parse(repo.read(`.architecture-campaigns/${id}.json`)) as Ledger;

            for (const id of CAMPAIGNS) {
              const init = cli(repo, ["campaigns", "init", id, "src"]);
              expect(init.code, init.stderr).toBe(0);
              expect(written(id).entries).toEqual([...new Set(hitsOf(before.json, id))]);
              expect(written(id).initial).toBe(written(id).entries.length);
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

            // Nothing fixed: prune is a no-op, and says so.
            const idle = cli(repo, ["campaigns", "prune", "src"]);
            expect(idle.code, idle.stderr).toBe(0);
            expect(idle.stdout).toContain("nothing to prune");

            // A file that hit both campaigns is deleted: both ledgers are
            // stale, check fails, and prune reproduces the hits.
            const victim = tree.files.find((file) => /\/(handler|service)\.ts$/.test(file));
            if (victim === undefined) return;
            repo.remove(victim);
            const stale = check(repo, ["src"]);
            expect(stale.code).toBe(1);
            expect(stale.json.campaigns.map((one) => one.stale.length > 0)).toEqual([true, true]);

            const pruned = cli(repo, ["campaigns", "prune", "src"]);
            expect(pruned.code, pruned.stderr).toBe(0);
            const settled = check(repo, ["src"]);
            expect(
              settled.json.campaigns.every((one) => one.new.length === 0 && one.stale.length === 0),
            ).toBe(true);
            for (const id of CAMPAIGNS) {
              expect(written(id).entries).toEqual([...new Set(hitsOf(settled.json, id))]);
              expect(written(id).fixed).toBeGreaterThan(0);
              expect(written(id).initial - written(id).fixed).toBe(written(id).entries.length);
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
