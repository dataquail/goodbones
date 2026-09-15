import {
  evaluateSelectedBindings,
  exportRulesSelecting,
  formatMessage,
  type LoadedPolicy,
  type SelectedExportRule,
} from "@goodbones/core";
import type { ReadBinding, ReadEdge } from "@goodbones/typescript";
import * as Result from "effect/Result";

import {
  at,
  factsOfProgram,
  type Fixer,
  type OxlintRule,
  type Program,
  type RuleContext,
  toRepoRelative,
} from "./oxlint-api.js";

// `import { A, B as C } from "pkg"` becomes `import * as A from "pkg/A"` and
// `import * as C from "pkg/B"`. Only whole-declaration rewrites are offered: a
// declaration mixing restricted named imports with a default or namespace one
// would need comma surgery inside the braces, and a fix that is subtly wrong is
// worse than a diagnostic the author resolves by hand.
const subpathNamespaceImport = (specifier: string, bound: ReadonlyArray<ReadBinding>): string =>
  bound
    .map((binding) => `import * as ${binding.local} from "${specifier}/${binding.symbol}";`)
    .join("\n");

export const makeExportsRule = (policy: LoadedPolicy): OxlintRule => ({
  meta: {
    type: "problem" as const,
    fixable: "code" as const,
    docs: {
      description:
        "which exported symbols a file may import, for rules a path alone cannot express",
    },
    schema: [],
  },

  createOnce(context: RuleContext) {
    let importer = "";
    let selected: ReadonlyArray<SelectedExportRule> = [];

    // Only an `import` declaration can be rewritten into subpath namespace
    // imports. `export *` and the whole-module forms are reported and left
    // for the author.
    const check = (edge: ReadEdge): void => {
      const { bindings: bound, node, specifier } = edge;
      if (bound.length === 0) return;

      const outcome = evaluateSelectedBindings(selected, policy.resolver, {
        importer,
        specifier,
        bindings: bound,
      });

      if (Result.isFailure(outcome)) {
        // `architecture/imports` reports the same unresolved edge, so staying
        // quiet here avoids two diagnostics for one broken specifier.
        return;
      }

      for (const { bindings, rule, violation } of outcome.success) {
        if (policy.baseline.isBaselined(violation)) continue;
        const offending = bound.filter((one) =>
          bindings.some((binding) => binding.symbol === one.symbol && binding.kind === one.kind),
        );
        // The rewrite is `import * as X from "pkg/<name>"`, which only means
        // something for a named binding — a namespace one has no name to put
        // in the subpath.
        const rewritable =
          edge.form === "import" &&
          rule.fix === "subpath-namespace-import" &&
          offending.length === bound.length &&
          offending.every((one) => one.kind === "named");

        if (rewritable) {
          context.report({
            node: at(node),
            message: formatMessage(violation),
            fix: (fixer: Fixer) =>
              fixer.replaceText(at(node), subpathNamespaceImport(specifier, offending)),
          });
          continue;
        }

        context.report({
          node: at(offending[0]?.node ?? node),
          message: formatMessage(violation),
        });
      }
    };

    return {
      before() {
        importer = toRepoRelative(policy.repoRoot, context.filename);
        if (importer.startsWith("..")) return false;
        selected = exportRulesSelecting(policy.exportRules, importer);
        return selected.length > 0;
      },
      Program(node: Program) {
        for (const edge of factsOfProgram(importer, node).edges) check(edge);
      },
    };
  },
});
