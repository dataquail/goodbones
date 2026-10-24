import { countedFiles, coverageOf, fractionsOf, listSourceFiles } from "@goodbones/core";
import * as Effect from "effect/Effect";

import type { LoadedPolicy } from "../config-loader.js";
import { type CliFailure, report } from "../output.js";
import { outsideNote, outsideOf, percent, unreachedMark } from "../report.js";

// How much of the tree the policy reaches. A probe proves a rule can fire;
// this is whether the files are there to fire on. Reported per family, with the
// adoption backlog — the tiers that said "not tightened yet" — beneath it.
export const coverage = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    // The limits are held over the files they count, so that is what the
    // rows are over: what `limits.outside` names is said, and left out.
    const walked = listSourceFiles(policy.repoRoot, roots, policy.languages);
    const files = countedFiles(walked, outsideOf(policy));
    const found = coverageOf(policy, files);
    const fractions = fractionsOf(found);
    const floors = policy.config.limits?.coverage ?? {};
    const ceilings = policy.config.limits?.unreached ?? {};

    const row = (family: keyof typeof fractions, covered: number, note: string): string => {
      const floor = floors[family];

      const mark =
        floor === undefined
          ? ""
          : fractions[family] >= floor
            ? `  ≥ ${percent(floor)} ✓`
            : `  < ${percent(floor)} ✗`;

      return `  ${family.padEnd(10)} ${String(covered).padStart(5)}/${String(found.files)}  ${percent(fractions[family]).padStart(4)}  ${note}${mark}${unreachedMark(covered, found.files, ceilings[family])}`;
    };

    yield* report([
      `${String(walked.length)} files under ${roots.join(", ")}${outsideNote(walked.length - files.length)}`,
      "",
      row("imports", found.imports.covered, "under an import allowlist"),
      row(
        "structure",
        found.structure.enumerated,
        `in an enumerated folder (${String(found.structure.open)} in an open one, ${String(found.structure.total - found.structure.enumerated - found.structure.open)} in none)`,
      ),
      row("members", found.members.covered, "selected by a members rule"),
      row("surface", found.surface.covered, "selected by a surface rule"),
      row("graph", found.graph.covered, "in a cycles or orphans scope"),
      "",
      `  unrestricted tiers: ${policy.adoption.unrestricted.length === 0 ? "(none)" : policy.adoption.unrestricted.join(", ")}`,
      `  partial tiers:      ${policy.adoption.partial.length === 0 ? "(none)" : policy.adoption.partial.join(", ")}`,
    ]);
  });
