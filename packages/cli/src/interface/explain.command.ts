import * as path from "node:path";

import {
  exportRulesSelecting,
  memberRulesSelecting,
  requiredSiblingsOf,
  rulesSelecting,
  surfaceRulesSelecting,
} from "@goodbones/core";
import * as Effect from "effect/Effect";

import type { LoadedPolicy } from "../config-loader.js";
import { collectFindings } from "../findings.js";
import { type CliFailure, report } from "../output.js";

// The question a tree config makes harder to answer than a flat one: given a
// file, what governs it? A flat config you grep; a tree you have to walk.
export const explain = (
  policy: LoadedPolicy,
  file: string,
  roots: ReadonlyArray<string> = ["packages"],
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const relative = path.relative(policy.repoRoot, path.resolve(policy.repoRoot, file));
    const selected = rulesSelecting(policy.importRules, relative);

    // An allowlist rule names no `to` — it fires when the target matches none of
    // its patterns. A prohibition names one.
    const allowlists = selected.filter(([rule]) => rule.to.length === 0 && rule.toNot.length > 0);
    const prohibitions = selected.filter(([rule]) => rule.to.length > 0);

    const owed = policy.structure.parity
      .filter(
        (rule) =>
          rule.file.some((pattern) => pattern.test(relative)) &&
          !rule.fileNot.some((pattern) => pattern.test(relative)),
      )
      .flatMap((rule) => requiredSiblingsOf(rule, relative));

    const governing = policy.structure.folders.filter((rule) =>
      rule.folder.some((pattern) => pattern.test(path.dirname(relative))),
    );

    const naming = policy.structure.naming.filter(
      (rule) =>
        rule.file.some((pattern) => pattern.test(relative)) &&
        !rule.fileNot.some((pattern) => pattern.test(relative)),
    );

    const firstSentence = (message: string) =>
      `${(message.split(". ")[0] ?? message).replace(/\.$/, "")}.`;

    const named = (rule: { readonly name: string; readonly message: string }): string =>
      `    ${rule.name} — ${firstSentence(rule.message)}`;

    // The families beyond imports and structure: which rules of each speak to
    // this file at all. What they are evaluated against is `facts`' answer.
    const restricted = exportRulesSelecting(policy.exportRules, relative).map(([rule]) => rule);
    const vocabulary = memberRulesSelecting(policy.memberRules, relative);
    const surface = surfaceRulesSelecting(policy.surfaceRules, relative);

    const scoped = (rule: { within: ReadonlyArray<RegExp>; withinNot: ReadonlyArray<RegExp> }) =>
      rule.within.some((pattern) => pattern.test(relative)) &&
      !rule.withinNot.some((pattern) => pattern.test(relative));

    const graph = [
      ...policy.graph.cycles.filter(scoped).map((rule) => `${named(rule)} (cycles)`),
      ...policy.graph.orphans.filter(scoped).map((rule) => `${named(rule)} (orphans)`),
      ...policy.graph.reach
        .filter(
          (rule) =>
            rule.from.some((pattern) => pattern.test(relative)) &&
            !rule.fromNot.some((pattern) => pattern.test(relative)),
        )
        .map((rule) => `${named(rule)} (reach)`),
    ];

    const section = (title: string, lines: ReadonlyArray<string>): ReadonlyArray<string> =>
      lines.length === 0 ? [] : ["", title, ...lines];

    // The campaigns selecting the file, evaluated over their files only
    // when one does: a sector's phase is derived from all of them.
    const campaignLines = policy.campaigns.explainLines(
      policy,
      relative,
      () => collectFindings(policy, roots).campaigns,
    );

    yield* report([
      relative,
      "",
      allowlists.length === 0
        ? "  may import: anything (no tier above this file states an allowlist)"
        : "  may import:",
      ...allowlists.flatMap(([rule]) => [
        `    — ${rule.name}`,
        ...rule.toNot.map((pattern) => `        ${pattern}`),
        ...[...rule.externals].map((name) => `        external: ${name}`),
      ]),
      "",
      "  may not import:",
      ...(prohibitions.length === 0
        ? ["    (nothing beyond the allowlist above)"]
        : prohibitions.map(([rule]) => `    ${rule.name} — ${firstSentence(rule.message)}`)),
      "",
      `  lives in: ${governing.length === 0 ? "a folder no rule governs" : governing.map((rule) => rule.name).join(", ")}`,
      ...(naming.length === 0
        ? []
        : [
            "  is named by:",
            ...naming.map(
              (rule) =>
                `    ${rule.name} — ${rule.sameAs !== null ? "its folder's own name" : (rule.convention?.source ?? "")}`,
            ),
          ]),
      ...(owed.length === 0 ? [] : ["  owes:", ...owed.map((one) => `    ${one}`)]),
      ...section("  may not name (exports):", restricted.map(named)),
      ...section("  vocabulary (members):", vocabulary.map(named)),
      ...section("  may export (surface):", surface.map(named)),
      ...section("  graph:", graph),
      ...section("  campaigns:", campaignLines),
    ]);
  });
