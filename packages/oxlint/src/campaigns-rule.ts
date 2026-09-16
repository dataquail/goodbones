import {
  type CampaignHit,
  campaignsSelecting,
  type CompiledCampaign,
  evaluateCampaigns,
  formatMessage,
  leafTermsOf,
  type LoadedPolicy,
  reconcile,
  ReportUnavailable,
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

// A `report` a campaign names that cannot be read — a command the kernel
// refused to spawn, a file no step wrote — is one fact about the run, not
// one about each file the campaign selects. The live source keeps the
// failure per spec; this keeps which failures have been said, so the first
// selected file carries the notice and the rest stay quiet. Without it, a
// lint of eight hundred files is eight hundred copies of oxlint's generic
// "error running JS plugin", with the cause dropped by the terser formats.
const aside = (cause: ReportUnavailable): string =>
  `A report a campaign names could not be read, so no campaign naming it is judged in this ` +
  `run: ${cause.message}`;

export const makeCampaignsRule = (policy: LoadedPolicy): OxlintRule => {
  // Per rule instance, which is per plugin load — one process — rather than
  // per `createOnce`, which a host may call more often than that.
  const said = new Set<string>();
  return {
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
            leafTermsOf(rule.detect).some(
              (leaf) => leaf === "syntax" || leaf === "report" || leaf === "fn",
            ),
          );
          const input = {
            file,
            text,
            facts: sourceFactsOf(factsOfProgram(file, node)),
            resolver: policy.resolver,
            fileSystem: policy.fileSystem,
            syntax: needsSyntax ? policy.syntax.parse(file, text) : null,
            functions: policy.functions,
            reports: policy.reports,
          };
          // One campaign at a time, so a report one of them cannot read costs
          // that campaign's answer for this file and not its neighbours'.
          const hits: Array<CampaignHit> = [];
          for (const rule of selected) {
            try {
              for (const hit of evaluateCampaigns([rule], input)) hits.push(hit);
            } catch (cause) {
              if (!(cause instanceof ReportUnavailable)) throw cause;
              const message = aside(cause);
              if (said.has(message)) continue;
              said.add(message);
              context.report({ message, loc: { line: 1, column: 0 } });
            }
          }

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
  };
};
