import { type CampaignEvaluation, hitsInWindow } from "../../../../core/campaign-state.js";

// The base tree's side of the exact mode, reduced to what the nudge reads:
// each campaign's counts per sector and its hits in window — small enough
// to cache per commit.
export type BaseSide = ReadonlyArray<{
  readonly id: string;
  readonly sectors: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly hits: ReadonlyArray<{ sector: string; objective: string; entry: string }>;
  // Each scalar objective's value per sector. Absent from a base side cached
  // before scalars existed, and then the ledger stands in for it.
  readonly values?: Readonly<Record<string, Readonly<Record<string, number | null>>>>;
  // Each sector's phase in the base tree, by id; `null` past every phase.
  // Absent from a base side cached before the nudge judged by it, and then
  // the ledgers stand in for it.
  readonly phases?: Readonly<Record<string, string | null>>;
}>;

export const baseSideOf = (evaluations: ReadonlyArray<CampaignEvaluation>): BaseSide =>
  evaluations.map((evaluation) => ({
    id: evaluation.rule.id,
    sectors: Object.fromEntries(
      [...evaluation.sectors.values()].map((state) => [state.name, state.counts]),
    ),
    hits: hitsInWindow(evaluation).map((hit) => ({
      sector: hit.sector,
      objective: hit.objective,
      entry: hit.entry,
    })),
    // `NaN` does not survive the JSON cache; `null` is "no number".
    values: Object.fromEntries(
      [...evaluation.sectors.values()].map((state) => [
        state.name,
        Object.fromEntries(
          Object.entries(state.values).map(([id, value]) => [
            id,
            Number.isNaN(value) ? null : value,
          ]),
        ),
      ]),
    ),
    phases: Object.fromEntries(
      [...evaluation.sectors.values()].map((state) => [
        state.name,
        evaluation.rule.phases[state.phase]?.id ?? null,
      ]),
    ),
  }));
