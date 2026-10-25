import type { LoadedPolicy } from "@goodbones/core";

import type { CampaignEvaluation } from "../../../core/campaign-state.js";
import { isDefinedPhase } from "../../../core/phases.js";
import { isShared, LEGACY_SECTOR } from "../../../core/sectors.js";
import { campaignsOf } from "../../../load/campaign-policy.js";
import { positionOf } from "../domain/sector-record/sector-record.root-ops.js";
import { ledgerPhaseOf, recordOf } from "../domain/services/campaign-ledgers.service.js";
import type { SectorMove } from "./sector-moves.result.js";

// What the `clear` about to run will record of where each sector stands:
// the sectors the working tree carried to another phase than the one the
// ledgers placed them at.
export const previewSectorMovesUseCase = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
): ReadonlyArray<SectorMove> => {
  const { rule } = evaluation;
  const campaigns = campaignsOf(policy);
  const moves: Array<SectorMove> = [];

  for (const [name, state] of evaluation.sectors) {
    // A sector no `clear` has placed has not moved: it is placed.
    if (name === LEGACY_SECTOR || isShared(rule, name)) continue;
    const record = recordOf(campaigns, rule, name);

    if (record === undefined) continue;
    // Where the ledgers place it — or, when that is where the tree has it
    // already (an attestation since the last `clear` moved it there), the
    // furthest phase the record says it reached, which this `clear` advances.
    const placed = ledgerPhaseOf(campaigns, rule, name);
    const { reached } = positionOf(rule, record);
    const from = placed === state.phase && reached >= 0 ? Math.min(reached, placed) : placed;

    if (from === state.phase) continue;
    moves.push({
      campaign: rule.id,
      sector: name,
      from: rule.phases[from]?.id ?? null,
      to: rule.phases[state.phase]?.id ?? null,
      back: state.phase < from,
      passed: rule.phases
        .slice(from + 1, Math.max(from + 1, state.phase))
        .filter((phase) => isDefinedPhase(phase))
        .map((phase) => phase.id),
    });
  }

  return moves;
};
