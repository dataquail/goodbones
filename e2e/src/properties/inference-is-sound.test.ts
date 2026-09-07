import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { check, cli } from "../cli.js";
import { typescript } from "../profile.js";
import { arbTree, parameters, PROPERTY_TIMEOUT, repoOf, tick } from "./generators.js";

// Inference is sound: what `infer` writes, `check` accepts — for every tree,
// with every way of answering the questions.

describe("inference is sound", () => {
  it(
    "infer then check is ok, exhaustively, with --yes, and with --collapse",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbTree(typescript), async (tree) => {
          await tick();
          const repo = repoOf(tree);
          try {
            for (const [name, flags] of [
              ["exhaustive", ["--exhaustive"]],
              ["yes", ["--yes"]],
              ["collapse", ["--exhaustive", "--collapse"]],
            ] as const) {
              const inferred = cli(repo, ["infer", ...flags]);
              expect(inferred.code, inferred.stderr).toBe(0);
              const manifest = `policy/${name}.yaml`;
              repo.write(manifest, inferred.stdout);

              const checked = check(repo, ["src"], { env: { ARCHITECTURE_CONFIG: manifest } });
              expect(checked.json.violations, `${name}: ${checked.stderr}`).toEqual([]);
              expect(checked.json.unresolved, name).toEqual([]);
              expect(checked.json.ok, name).toBe(true);
              expect(checked.json.files).toBe(tree.files.length);
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
