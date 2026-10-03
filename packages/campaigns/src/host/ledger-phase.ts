import type { LoadedPolicy } from "@goodbones/core";

import { type CompiledCampaign, distanceToTarget } from "../core/campaigns.js";
import { positionOf } from "../core/ledger.js";
import { derivePhase, donePhaseOf, growsAt, LEGACY_PHASE } from "../core/phases.js";
import { isShared, LEGACY_SECTOR, SHARED_SECTOR } from "../core/sectors.js";
import { campaignsOf, ledgerKeyOf } from "../load/extension.js";

// The phase the ledgers place a sector at: derived from what the last
// `clear` wrote — each objective's holdouts for it, a scalar's record, its
// own `reached` and attestations — and never from a walk. It is where the
// sector stood before whatever the working tree has done since, which is
// what a diff is judged by. A sector no `clear` has placed stands at the
// first phase, as the legacy does.
export const ledgerPhaseOf = (
  policy: LoadedPolicy,
  rule: CompiledCampaign,
  sector: string,
): number => {
  // The shared files stand on no phase, before a change or after it.
  if (isShared(rule, sector)) return donePhaseOf(rule);
  const state = campaignsOf(policy);
  const record = state.sectorRecords.get(ledgerKeyOf(rule.id, sector));
  if (sector === LEGACY_SECTOR || record === undefined) {
    return Math.min(LEGACY_PHASE, rule.phases.length);
  }
  const counts = (objectiveId: string): number => {
    const key = ledgerKeyOf(rule.id, objectiveId);
    const objective = rule.objectives.find((one) => one.id === objectiveId);
    // A prerequisite is ledgered under the shared files, and holds this sector
    // by what is recorded there.
    const at = objective?.overShared === true ? SHARED_SECTOR : sector;
    if (objective !== undefined && objective.measure !== null) {
      const own = state.measureLedgers.get(key)?.sectors[at];
      return own === undefined || own.closed !== null
        ? 0
        : distanceToTarget(objective, own.recorded);
    }
    return state.ledgers.get(key)?.sectors[at]?.holdouts.length ?? 0;
  };
  return derivePhase(rule, counts, positionOf(rule, record));
};

// Whether the phase the ledgers place a sector at expects a scalar objective
// to rise. A rise there is `clear`'s to record, as an improvement is — never
// growth someone must concede.
export const growsFor = (
  policy: LoadedPolicy,
  rule: CompiledCampaign,
  sector: string,
  objectiveId: string,
): boolean =>
  // The shared files hold no number: a scalar there is measured, and `clear`
  // records it wherever it stands.
  isShared(rule, sector) || growsAt(rule, ledgerPhaseOf(policy, rule, sector), objectiveId);
