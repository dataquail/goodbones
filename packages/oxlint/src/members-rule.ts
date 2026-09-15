import {
  type CompiledMemberRule,
  evaluateMemberSite,
  formatMessage,
  type LoadedPolicy,
  memberRulesSelecting,
} from "@goodbones/core";

import {
  at,
  factsOfProgram,
  type OxlintRule,
  type Program,
  type RuleContext,
  toRepoRelative,
} from "./oxlint-api.js";

export const makeMembersRule = (policy: LoadedPolicy): OxlintRule => ({
  meta: {
    type: "problem" as const,
    docs: {
      description:
        "which names a file may declare or call — a port's method vocabulary, a tier's allowed hooks",
    },
    schema: [],
  },

  createOnce(context: RuleContext) {
    let file = "";
    let selected: ReadonlyArray<CompiledMemberRule> = [];

    // A declared member is reported at its key, a call at the call — the nodes
    // the pack's reader hands back with each site.
    return {
      before() {
        file = toRepoRelative(policy.repoRoot, context.filename);
        if (file.startsWith("..")) return false;
        selected = memberRulesSelecting(policy.memberRules, file);
        return selected.length > 0;
      },
      Program(node: Program) {
        for (const site of factsOfProgram(file, node).memberSites) {
          for (const violation of evaluateMemberSite(selected, site)) {
            if (policy.baseline.isBaselined(violation)) continue;
            context.report({ node: at(site.node), message: formatMessage(violation) });
          }
        }
      },
    };
  },
});
