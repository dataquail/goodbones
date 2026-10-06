import type { LoadedPolicy } from "@goodbones/core";

import { type CompiledCampaign, distanceToTarget } from "../core/campaigns.js";
import { type Ledger, type MeasureLedger, positionOf, type SectorRecord } from "../core/ledger.js";
import { derivePhase, donePhaseOf, growsAt, LEGACY_PHASE, windowOf } from "../core/phases.js";
import { isShared, LEGACY_SECTOR, SHARED_SECTOR } from "../core/sectors.js";
import { campaignsOf, ledgerKeyOf } from "../load/extension.js";

// The phase the ledgers place a sector at: derived from what the last
// `clear` wrote — each objective's holdouts for it, a scalar's record, its
// own `reached` and attestations — and never from a walk. It is where the
// sector stood before whatever the working tree has done since, which is
// what a diff is judged by. A sector no `clear` has placed stands at the
// first phase, as the legacy does.
// Ledgers to read in place of the loaded ones, by objective id — those a
// verb is about to write, or HEAD's — where the question is where they would
// place the sector. An objective mapped to `undefined` has no ledger there.
export type LedgerOverrides = {
  readonly ledgers?: ReadonlyMap<string, Ledger | undefined>;
  readonly measures?: ReadonlyMap<string, MeasureLedger | undefined>;
  // The sector's record in place of the loaded one: what it reached, and
  // which attestations were live.
  readonly record?: { readonly at: SectorRecord | undefined };
};

export const ledgerPhaseOf = (
  policy: LoadedPolicy,
  rule: CompiledCampaign,
  sector: string,
  overrides: LedgerOverrides = {},
): number => {
  // The shared files stand on no phase, before a change or after it.
  if (isShared(rule, sector)) return donePhaseOf(rule);
  const state = campaignsOf(policy);
  const record =
    overrides.record === undefined
      ? state.sectorRecords.get(ledgerKeyOf(rule.id, sector))
      : overrides.record.at;
  if (sector === LEGACY_SECTOR || record === undefined) {
    return Math.min(LEGACY_PHASE, rule.phases.length);
  }
  const position = positionOf(rule, record);
  const counts = (objectiveId: string): number => {
    const key = ledgerKeyOf(rule.id, objectiveId);
    const objective = rule.objectives.find((one) => one.id === objectiveId);
    if (objective === undefined) return 0;
    // A prerequisite is ledgered under the shared files, and holds this sector
    // by what is recorded there.
    const at = objective.overShared ? SHARED_SECTOR : sector;
    // An objective no ledger has recorded for the sector is one it never
    // entered. Up to the phase the sector has reached, that was a window
    // passed in one `clear` — met. Past it, nothing says it is met, and
    // reading it as nought would carry the sector past phases it has
    // never stood at.
    const unentered = (): number => (windowOf(rule, objective).from > position.reached ? 1 : 0);
    if (objective.measure !== null) {
      const own = (
        overrides.measures?.has(objectiveId) === true
          ? overrides.measures.get(objectiveId)
          : state.measureLedgers.get(key)
      )?.sectors[at];
      if (own === undefined) return unentered();
      return own.closed !== null ? 0 : distanceToTarget(objective, own.recorded);
    }
    const own = (
      overrides.ledgers?.has(objectiveId) === true
        ? overrides.ledgers.get(objectiveId)
        : state.ledgers.get(key)
    )?.sectors[at];
    return own === undefined ? unentered() : own.holdouts.length;
  };
  return derivePhase(rule, counts, position);
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
