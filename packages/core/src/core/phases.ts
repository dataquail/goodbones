import type { OnTouch, PhaseRule } from "../domain/architecture-config.js";
import type { CompiledCampaign, CompiledObjective } from "./campaigns.js";

// A phase is a named, ordered group of objectives: defined when it names
// one (or is attested, or carries an end state), open when it has only an
// intent — and then it is last. A sector's phase is derived, never
// declared: the first phase, in order, with residue for that sector. What
// derivation cannot say is where a sector has been, and windows need that,
// so the per-sector ledger records the furthest phase ever reached.

// The index a sector past every phase stands at.
export const donePhaseOf = (rule: CompiledCampaign): number => rule.phases.length;

// The phase the legacy stands at: the first, so the first phase's
// objectives count for what no sector has claimed, and it is not a sink.
export const LEGACY_PHASE = 0;

export const isOpenPhase = (phase: PhaseRule): boolean =>
  phase.objectives.length === 0 && !phase.attested;

export const isDefinedPhase = (phase: PhaseRule): boolean => !isOpenPhase(phase);

// What the sector's own record says about its position: the furthest phase
// derived for it so far (`-1` before any `clear`), and the phases attested.
export type SectorPosition = {
  readonly reached: number;
  readonly attested: ReadonlySet<string>;
};

export const UNPLACED: SectorPosition = { reached: -1, attested: new Set() };

export type Window = {
  // The index of the phase naming the objective; `-1` for one no phase
  // names, which is in window everywhere, the legacy included.
  readonly from: number;
  // Exclusive; `Infinity` to the end.
  readonly until: number;
};

export const windowOf = (rule: CompiledCampaign, objective: CompiledObjective): Window => {
  const from = rule.phases.findIndex((phase) => phase.objectives.includes(objective.id));
  const until =
    objective.until === null
      ? Number.POSITIVE_INFINITY
      : rule.phases.findIndex((phase) => phase.id === objective.until);
  return { from, until: until === -1 ? Number.POSITIVE_INFINITY : until };
};

// A window a sector has passed never reopens for it: when a later plan edit
// sends the sector back down the ladder, the transitional shapes it has
// already been through are not demanded again.
export const isShut = (
  rule: CompiledCampaign,
  objective: CompiledObjective,
  position: SectorPosition,
): boolean => {
  const { until } = windowOf(rule, objective);
  return Number.isFinite(until) && until <= position.reached;
};

export const inWindow = (
  rule: CompiledCampaign,
  objective: CompiledObjective,
  phase: number,
  position: SectorPosition,
): boolean => {
  if (isShut(rule, objective, position)) return false;
  const { from, until } = windowOf(rule, objective);
  return phase >= from && phase < until;
};

export const objectivesInWindow = (
  rule: CompiledCampaign,
  phase: number,
  position: SectorPosition,
): ReadonlyArray<CompiledObjective> =>
  rule.objectives.filter((objective) => inWindow(rule, objective, phase, position));

// The first phase, in order, with residue for the sector: an objective it
// names with a holdout in the sector (and a window not shut), an attested
// phase not yet attested for it, or the open phase, which always has
// residue. A sector past the last phase is done.
export const derivePhase = (
  rule: CompiledCampaign,
  counts: (objectiveId: string) => number,
  position: SectorPosition,
): number => {
  for (const [index, phase] of rule.phases.entries()) {
    if (isOpenPhase(phase)) return index;
    if (phase.attested && !position.attested.has(phase.id)) return index;
    const residue = phase.objectives.some((objectiveId) => {
      const objective = rule.objectives.find((one) => one.id === objectiveId);
      return (
        objective !== undefined &&
        !isShut(rule, objective, position) &&
        counts(objectiveId) > 0
      );
    });
    if (residue) return index;
  }
  return donePhaseOf(rule);
};

// What a touched sector owes: the phase's own word, else the campaign's,
// else `advise` for an open phase and `ratchet` for a defined one.
export const onTouchOf = (rule: CompiledCampaign, phase: number): OnTouch => {
  const at = rule.phases[phase];
  return (
    at?.onTouch ??
    rule.onTouch ??
    (at !== undefined && isOpenPhase(at) ? "advise" : "ratchet")
  );
};

// The residue vector: one dimension per objective in window, never summed.
export type Residue = Readonly<Record<string, number>>;

export type Direction = "forward" | "back" | "mixed" | "neutral";

// Forward means no dimension is worse and at least one is better; back the
// reverse; anything else is mixed and is reported as such, never resolved
// by a sum.
export const compareResidue = (before: Residue, after: Residue): Direction => {
  let better = false;
  let worse = false;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key] ?? 0;
    const to = after[key] ?? 0;
    if (to < from) better = true;
    if (to > from) worse = true;
  }
  if (better && worse) return "mixed";
  if (better) return "forward";
  if (worse) return "back";
  return "neutral";
};

// The dimensions that went back, by name.
export const worsened = (before: Residue, after: Residue): ReadonlyArray<string> =>
  Object.keys(after)
    .filter((key) => (after[key] ?? 0) > (before[key] ?? 0))
    .sort();
