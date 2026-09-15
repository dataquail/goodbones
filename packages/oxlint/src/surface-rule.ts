import {
  type CompiledSurfaceRule,
  evaluateSurface,
  formatMessage,
  type LoadedPolicy,
  surfaceRulesSelecting,
} from "@goodbones/core";
import type { ReadExportSite } from "@goodbones/typescript";

import {
  at,
  factsOfProgram,
  type OxlintRule,
  type Program,
  type RuleContext,
  toRepoRelative,
} from "./oxlint-api.js";

export const makeSurfaceRule = (policy: LoadedPolicy): OxlintRule => ({
  meta: {
    type: "problem" as const,
    docs: {
      description:
        "what a file may export — no default exports, a barrel that only re-exports, a handler that exports one function",
    },
    schema: [],
  },

  createOnce(context: RuleContext) {
    let file = "";
    let selected: ReadonlyArray<CompiledSurfaceRule> = [];

    return {
      before() {
        file = toRepoRelative(policy.repoRoot, context.filename);
        if (file.startsWith("..")) return false;
        selected = surfaceRulesSelecting(policy.surfaceRules, file);
        return selected.length > 0;
      },

      Program(node: Program) {
        const sites = factsOfProgram(file, node).exportSites;
        const violations = evaluateSurface(selected, file, sites);

        // A per-site violation lands on the site's own node; a `count` one, on
        // the program — it is about the file.
        const used = new Set<ReadExportSite>();
        for (const violation of violations) {
          if (policy.baseline.isBaselined(violation)) continue;
          const site =
            violation.subject === null
              ? undefined
              : sites.find((one) => one.name === violation.subject && !used.has(one));
          if (site !== undefined) used.add(site);
          context.report({
            node: site === undefined ? node : at(site.node),
            message: formatMessage(violation),
          });
        }
      },
    };
  },
});
