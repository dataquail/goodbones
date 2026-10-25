import type { LoadedPolicy } from "@goodbones/core";

import {
  type CampaignEvaluation,
  hitsInWindow,
  towardNextOf,
} from "../../../core/campaign-state.js";
import { isOpenPhase } from "../../../core/phases.js";
import { SECTOR_HOLDOUT } from "../../../core/sectors.js";
import { campaignsOf } from "../../../load/campaign-policy.js";
import { positionOf } from "../domain/sector-record/sector-record.root-ops.js";
import {
  measureLedgerOf,
  phaseIdOf,
  recordOf,
} from "../domain/services/campaign-ledgers.service.js";
import type { SectorView } from "./sector-view.result.js";

// `campaigns status --sector <name>`: where one sector stands and what holds
// it there, read off the tree and its ledgers — the question a fresh session
// or a handoff starts with, answered without a file to `explain` or a JSON
// file to read. `null` for a sector the campaign does not birth.
export const viewSectorUseCase = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  name: string,
): SectorView | null => {
  const { rule } = evaluation;
  const campaigns = campaignsOf(policy);
  const state = evaluation.sectors.get(name);

  if (state === undefined) return null;
  const record = recordOf(campaigns, rule, name);
  const phase = rule.phases[state.phase];
  const hits = hitsInWindow(evaluation).filter((hit) => hit.sector === name);

  return {
    campaign: rule.id,
    sector: name,
    phase: {
      id: phaseIdOf(rule, state.phase),
      index: state.phase,
      of: rule.phases.length,
      open: phase !== undefined && isOpenPhase(phase),
      attested: phase?.attested === true,
      intent: phase?.intent ?? null,
    },
    reached:
      record === undefined ? null : (rule.phases[positionOf(rule, record).reached]?.id ?? null),
    since: record?.since ?? null,
    attestations: (record?.attested ?? []).map((one) => ({
      phase: one.phase,
      at: one.at,
      by: one.by,
      reason: one.reason,
      revoked: one.revoked ?? null,
    })),
    toward: towardNextOf(rule, state),
    objectives: state.inWindow
      .filter((objective) => objective.measure === null)
      .map((objective) => {
        const own = hits.filter((hit) => hit.objective === objective.id);

        return {
          id: objective.id,
          how: objective.message,
          count: own.length,
          holdouts: own
            .map((hit) =>
              hit.entry === SECTOR_HOLDOUT
                ? { file: null, line: null, subject: null }
                : {
                    file: hit.violation.file,
                    line: hit.range === undefined ? null : hit.range.start.line + 1,
                    subject: hit.violation.subject,
                  },
            )
            .sort((a, b) => {
              const byFile = (a.file ?? "").localeCompare(b.file ?? "");

              return byFile !== 0 ? byFile : (a.line ?? 0) - (b.line ?? 0);
            }),
        };
      }),
    measures: state.inWindow
      .filter((objective) => objective.measure !== null)
      .map((objective) => {
        const value = state.values[objective.id] ?? Number.NaN;
        const own = measureLedgerOf(campaigns, rule, objective)?.sectors[name];

        return {
          objective: objective.id,
          value: Number.isNaN(value) ? null : value,
          recorded: own === undefined || own.closed !== null ? null : own.recorded,
          target: objective.target,
          tolerance: objective.tolerance,
        };
      }),
    notes: (record?.notes ?? []).map((one) => ({ ...one })),
  };
};
