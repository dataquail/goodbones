import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { check, fingerprintsOf } from "../cli.js";
import { typescript } from "../profile.js";
import {
  arbTree,
  parameters,
  PROPERTY_TIMEOUT,
  repoOf,
  specsOf,
  tick,
  tightManifest,
} from "./generators.js";

// Fingerprints are position-free. Reorder every file's imports and pad every
// file with blank lines: the set of fingerprints is unchanged, which is what
// lets a baseline entry survive a reformat.

// A permutation of each file's imports, and how many blank lines go between
// its lines.
const arbShuffle = (tree: ReturnType<typeof specsOf>) =>
  fc.record(
    Object.fromEntries(
      Object.entries(tree).map(([file, spec]) => [
        file,
        fc.record({
          order: fc.shuffledSubarray(
            spec.imports.map((_, index) => index),
            { minLength: spec.imports.length, maxLength: spec.imports.length },
          ),
          padding: fc.integer({ min: 0, max: 3 }),
        }),
      ]),
    ),
  );

describe("fingerprints are position-free", () => {
  it(
    "reordering imports and inserting blank lines leaves the fingerprint set unchanged",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          arbTree(typescript).chain((tree) =>
            fc.tuple(fc.constant(tree), arbShuffle(specsOf(tree, typescript))),
          ),
          async ([tree, shuffle]) => {
            await tick();
            const repo = repoOf(tree);
            try {
              repo.writeManifest(tightManifest(repo.profile));
              const before = check(repo, ["src"]);
              expect(before.json.unresolved, before.stderr).toEqual([]);

              for (const [file, spec] of Object.entries(specsOf(tree, repo.profile))) {
                const { order, padding } = shuffle[file] ?? { order: [], padding: 0 };
                const reordered = repo.profile.render({
                  ...spec,
                  imports: order.map((index) => spec.imports[index] ?? ""),
                });
                repo.write(file, reordered.replaceAll("\n", `\n${"\n".repeat(padding)}`));
              }

              const after = check(repo, ["src"]);
              expect(fingerprintsOf(after.json)).toEqual(fingerprintsOf(before.json));
              expect(after.code).toBe(before.code);
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
