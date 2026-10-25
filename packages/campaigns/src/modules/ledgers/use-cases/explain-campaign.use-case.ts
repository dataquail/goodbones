import type { LoadedPolicy } from "@goodbones/core";

import { type CampaignEvaluation, hitsInWindow } from "../../../core/campaign-state.js";
import { isOpenPhase } from "../../../core/phases.js";
import { isShared } from "../../../core/sectors.js";
import { campaignsOf } from "../../../load/campaign-policy.js";
import { measureLedgerOf, recordOf } from "../domain/services/campaign-ledgers.service.js";
import type { CampaignExplanation } from "./campaign-explanation.result.js";

// `explain <file>`'s paragraph for one campaign, read off its evaluation and
// the sector's record and ledgers. `null` for a file in no sector.
export const explainCampaignUseCase = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  file: string,
): CampaignExplanation | null => {
  const { rule } = evaluation;
  const campaigns = campaignsOf(policy);
  const sector = evaluation.index.sectorOf(file);

  if (sector === null) return null;
  const state = evaluation.sectors.get(sector);

  if (state === undefined) return null;
  const phase = rule.phases[state.phase];

  const own = hitsInWindow(evaluation)
    .filter((hit) => hit.sector === sector && hit.violation.file === file)
    .sort((a, b) => (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0));

  const firing = new Set(own.map((hit) => hit.objective));

  return {
    campaign: { id: rule.id, name: rule.name, phases: rule.phases.length },
    sector,
    shared: isShared(rule, sector),
    index: state.phase,
    phase:
      phase === undefined
        ? null
        : {
            id: phase.id,
            open: isOpenPhase(phase),
            attested: phase.attested,
            intent: phase.intent ?? null,
          },
    reached: recordOf(campaigns, rule, sector)?.reached ?? null,
    inWindow: state.inWindow.map((one) => ({ id: one.id, firing: firing.has(one.id) })),
    measures: state.inWindow
      .filter((one) => one.measure !== null)
      .map((one) => {
        const recorded = measureLedgerOf(campaigns, rule, one)?.sectors[sector];

        return {
          id: one.id,
          value: state.values[one.id] ?? Number.NaN,
          recorded: recorded === undefined || recorded.closed !== null ? null : recorded.recorded,
          target: one.target,
        };
      }),
    holdouts: own.map((hit) => ({
      line: hit.range === undefined ? null : hit.range.start.line + 1,
      objective: hit.objective,
      subject: hit.violation.subject,
    })),
  };
};
