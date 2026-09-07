import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { check, cli, fingerprintsOf } from "../cli.js";
import { exports, imports, typescript } from "../profile.js";
import {
  arbTree,
  parameters,
  PROPERTY_TIMEOUT,
  repoOf,
  specsOf,
  tick,
  type Tree,
} from "./generators.js";

// One edge, one finding. From a manifest inferred over the tree and checked
// clean, one import added to one file, pointing outside every allowlist the
// tree could have — a file outside the walked root — is exactly one new
// `import` fingerprint, naming that importer and that target. Removing it is
// zero again.
//
// The importer is a file that already imports something: its tier then has an
// allowlist to be outside of. A tier whose files import nothing is written
// `unrestricted`, with no allowlist at all, and admits the edge — which is
// what `coverage` is for, not this property.

const OUTSIDE = "lib/outside.ts";

const importers = (tree: Tree): ReadonlyArray<number> =>
  tree.edges.flatMap((edge, index) =>
    edge.local.length + edge.external.length > 0 ? [index] : [],
  );

describe("one edge, one finding", () => {
  it(
    "adding an import outside the allowlist is one import fingerprint on the importer; removing it, none",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          arbTree(typescript)
            .filter((tree) => importers(tree).length > 0)
            .chain((tree) => fc.tuple(fc.constant(tree), fc.constantFrom(...importers(tree)))),
          async ([tree, index]) => {
            await tick();
            const repo = repoOf(tree);
            try {
              repo.write(OUTSIDE, exports("outside"));
              const inferred = cli(repo, ["infer", "--exhaustive", "--write"]);
              expect(inferred.code, inferred.stderr).toBe(0);
              const before = check(repo, ["src"]);
              expect(before.json.ok, before.stderr).toBe(true);

              const importer = tree.files[index] ?? "";
              const spec = specsOf(tree, repo.profile)[importer] ?? imports();
              repo.write(importer, {
                ...spec,
                imports: [...spec.imports, repo.profile.specifier(importer, OUTSIDE)],
              });

              const after = check(repo, ["src"]);
              expect(after.json.ok).toBe(false);
              expect(after.json.unresolved).toEqual([]);
              const added = fingerprintsOf(after.json).filter(
                (one) => !fingerprintsOf(before.json).includes(one),
              );
              expect(added).toHaveLength(1);
              expect(added[0]).toMatch(/^import\|/);
              expect(added[0]).toContain(`|${importer}|${OUTSIDE}`);
              expect(after.json.violations[0]?.file).toBe(importer);

              repo.write(importer, spec);
              const restored = check(repo, ["src"]);
              expect(fingerprintsOf(restored.json)).toEqual(fingerprintsOf(before.json));
              expect(restored.json.ok).toBe(true);
            } finally {
              repo.dispose();
            }
          },
        ),
        parameters(),
      );
    },
    PROPERTY_TIMEOUT,
  );
});
