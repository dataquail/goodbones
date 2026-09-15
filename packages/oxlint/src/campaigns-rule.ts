import {
  type CampaignHit,
  campaignsSelecting,
  type CompiledCampaign,
  evaluateCampaigns,
  formatMessage,
  leafTermsOf,
  type LoadedPolicy,
  reconcile,
} from "@goodbones/core";
import { sourceFactsOf } from "@goodbones/typescript";

import {
  factsOfProgram,
  type OxlintRule,
  type Program,
  type RuleContext,
  toRepoRelative,
} from "./oxlint-api.js";

// The campaigns family, one file at a time: every hit of a campaign selecting
// the file that its ledger does not carry, reported at the match's position
// with the campaign's `how` as the message. The facts come from oxlint's tree
// through the pack's reader, as the other rules read them; the `syntax` term
// is answered by the same matcher the CLI uses, over `sourceCode.text` —
// "one engine" is this family's parity contract, rather than a corpus.

// Whether a hit is carried by the ledger, judged against the file's hits
// alone: entries are per file, so a file's reconciliation is the whole
// campaign's restricted to it.
const unledgered = (
  policy: LoadedPolicy,
  selected: ReadonlyArray<CompiledCampaign>,
  hits: ReadonlyArray<CampaignHit>,
): ReadonlyArray<CampaignHit> => {
  const carried = new Set<CampaignHit["violation"]>();
  for (const rule of selected) {
    const ledger = policy.ledgers.get(rule.id);
    if (ledger === undefined) continue;
    const own = hits.filter((hit) => hit.campaign === rule.id).map((hit) => hit.violation);
    for (const one of reconcile(ledger, own, rule.unit).ledgered) carried.add(one);
  }
  return hits.filter((hit) => !carried.has(hit.violation));
};

export const makeCampaignsRule = (policy: LoadedPolicy): OxlintRule => ({
  meta: {
    type: "problem" as const,
    docs: {
      description:
        "the campaigns: every place a pattern the repository is migrating away from still occurs, that its ledger does not carry",
    },
    schema: [],
  },

  createOnce(context: RuleContext) {
    let file = "";
    let selected: ReadonlyArray<CompiledCampaign> = [];

    return {
      before() {
        file = toRepoRelative(policy.repoRoot, context.filename);
        if (file.startsWith("..")) return false;
        selected = campaignsSelecting(policy.campaignRules, file);
        return selected.length > 0;
      },

      Program(node: Program) {
        const text = context.sourceCode.text;
        const needsSyntax = selected.some((rule) =>
          leafTermsOf(rule.detect).some((leaf) => leaf === "syntax" || leaf === "fn"),
        );
        const hits = evaluateCampaigns(selected, {
          file,
          text,
          facts: sourceFactsOf(factsOfProgram(file, node)),
          resolver: policy.resolver,
          fileSystem: policy.fileSystem,
          syntax: needsSyntax ? policy.syntax.parse(file, text) : null,
          functions: policy.functions,
        });

        for (const hit of unledgered(policy, selected, hits)) {
          // A match lands where it was found; a file-unit hit, on line 1, as
          // the structure rule places a finding about the file itself.
          const at = hit.range ?? { start: { line: 0, column: 0 } };
          context.report({
            message: formatMessage(hit.violation),
            loc: { line: at.start.line + 1, column: at.start.column },
          });
        }
      },
    };
  },
});
