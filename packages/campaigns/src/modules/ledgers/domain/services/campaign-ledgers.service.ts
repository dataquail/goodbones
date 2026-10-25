import type { CampaignEvaluation, ObjectiveHit } from "../../../../core/campaign-state.js";
import {
  type CompiledCampaign,
  type CompiledObjective,
  distanceToTarget,
} from "../../../../core/campaigns.js";
import {
  derivePhase,
  donePhaseOf,
  growsAt,
  LEGACY_PHASE,
  windowOf,
} from "../../../../core/phases.js";
import { isShared, LEGACY_SECTOR, SHARED_SECTOR } from "../../../../core/sectors.js";
import type { Ledger } from "../ledger/ledger.root.js";
import type { MeasureLedger } from "../measure-ledger/measure-ledger.root.js";
import type { PlanRecord } from "../plan/plan.root.js";
import type { SectorRecord } from "../sector-record/sector-record.root.js";
import { positionOf } from "../sector-record/sector-record.root-ops.js";

// What the ledgers say, read the same way by every verb: the ledgers,
// records and plans a policy was loaded with, a sector's entries off the
// hits, and the phase the ledgers place a sector at.

// Keyed `<campaign>/<objective>`, and `<campaign>/<sector>` for a record.
export const ledgerKeyOf = (campaign: string, objective: string): string =>
  `${campaign}/${objective}`;

// Every ledger, record and plan the policy was loaded with. `CampaignPolicy`
// is one; a verb asking where other ledgers would place a sector passes
// those as `LedgerOverrides` instead.
export type CampaignLedgers = {
  // Keyed `<campaign>/<objective>`: the holdout ledgers, and the scalar
  // objectives' in a map of their own — the same file, a second schema.
  readonly ledgers: ReadonlyMap<string, Ledger>;
  readonly measureLedgers: ReadonlyMap<string, MeasureLedger>;
  // Keyed `<campaign>/<sector>`.
  readonly sectorRecords: ReadonlyMap<string, SectorRecord>;
  // What `clear` last saw of each campaign's phases, by campaign.
  readonly plans: ReadonlyMap<string, PlanRecord>;
};

export const ledgerOf = (
  state: CampaignLedgers,
  rule: CompiledCampaign,
  objective: CompiledObjective,
): Ledger | undefined => state.ledgers.get(ledgerKeyOf(rule.id, objective.id));

export const measureLedgerOf = (
  state: CampaignLedgers,
  rule: CompiledCampaign,
  objective: CompiledObjective,
): MeasureLedger | undefined => state.measureLedgers.get(ledgerKeyOf(rule.id, objective.id));

export const recordOf = (
  state: CampaignLedgers,
  rule: CompiledCampaign,
  sector: string,
): SectorRecord | undefined => state.sectorRecords.get(ledgerKeyOf(rule.id, sector));

export const phaseIdOf = (rule: CompiledCampaign, phase: number): string | null =>
  rule.phases[phase]?.id ?? null;

export const entriesOf = (
  hits: ReadonlyArray<Pick<ObjectiveHit, "objective" | "sector" | "entry">>,
  objective: string,
  sector: string,
): ReadonlyArray<string> =>
  hits.flatMap((hit) => (hit.objective === objective && hit.sector === sector ? [hit.entry] : []));

export const sectorNames = (evaluation: CampaignEvaluation): ReadonlyArray<string> => [
  ...evaluation.sectors.keys(),
];

// How many holdouts a reader is shown at once: the nearest, not the list.
export const HOLDOUT_CAP = 5;

// ---------------------------------------------------------------------------
// The phase the ledgers place a sector at

// Derived from what the last `clear` wrote — each objective's holdouts for
// it, a scalar's record, its own `reached` and attestations — and never from
// a walk. It is where the sector stood before whatever the working tree has
// done since, which is what a diff is judged by. A sector no `clear` has
// placed stands at the first phase, as the legacy does.
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
  state: CampaignLedgers,
  rule: CompiledCampaign,
  sector: string,
  overrides: LedgerOverrides = {},
): number => {
  // The shared files stand on no phase, before a change or after it.
  if (isShared(rule, sector)) return donePhaseOf(rule);

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
  state: CampaignLedgers,
  rule: CompiledCampaign,
  sector: string,
  objectiveId: string,
): boolean =>
  // The shared files hold no number: a scalar there is measured, and `clear`
  // records it wherever it stands.
  isShared(rule, sector) || growsAt(rule, ledgerPhaseOf(state, rule, sector), objectiveId);

// How a scalar reads in a line: its value, and against what.
export const describeValue = (value: number): string =>
  Number.isNaN(value) ? "no number" : String(value);
