import type { CompiledCampaign } from "../../../../core/campaigns.js";
import { isDefinedPhase } from "../../../../core/phases.js";
import type { PhaseRule } from "../../../../domain/config.js";
import { digest } from "../../../../domain/digest.js";
import type { PlanRecord } from "./plan.root.js";

// What `clear` records of a campaign's phases, and what changed since.

export const planOf = (rule: CompiledCampaign): PlanRecord => ({
  version: 2,
  campaign: rule.id,
  phases: rule.phases.map((phase) => ({
    id: phase.id,
    hash: phase.hash,
    defined: isDefinedPhase(phase),
    concessions: phase.concessions.length,
  })),
});

export type PlanDiff = {
  // Open phases that gained criteria, and phases that are new: free.
  readonly refined: ReadonlyArray<string>;
  // Defined phases whose definition changed, or that were removed.
  readonly changed: ReadonlyArray<string>;
  // Changed phases with no new concession — what fails `check`.
  readonly unreceipted: ReadonlyArray<string>;
};

// What a version 1 plan recorded for a phase standing at `index`: the digest
// of its definition with the index in it. A rule built by hand carries no
// definition, and its hash stands in.
const placedHashOf = (phase: PhaseRule, index: number): string =>
  typeof phase.definition === "object" && phase.definition !== null
    ? digest({ ...phase.definition, index })
    : phase.hash;

// The longest run of ids two orders agree on; what is outside it moved.
const keptInOrder = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): ReadonlySet<string> => {
  const lengths: Array<Array<number>> = before.map(() => after.map(() => 0));
  const at = (i: number, j: number): number => lengths[i]?.[j] ?? 0;

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const row = lengths[i];

      if (row === undefined) continue;
      row[j] = before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const kept = new Set<string>();
  let i = 0;
  let j = 0;

  while (i < before.length && j < after.length) {
    const id = before[i];

    if (id !== undefined && id === after[j]) {
      kept.add(id);
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) i += 1;
    else j += 1;
  }

  return kept;
};

export const planDiffOf = (rule: CompiledCampaign, recorded: PlanRecord | undefined): PlanDiff => {
  if (recorded === undefined) return { refined: [], changed: [], unreceipted: [] };
  const refined: Array<string> = [];
  const changed: Array<string> = [];
  const unreceipted: Array<string> = [];

  // The phases both plans have, in each one's order: what stands outside
  // their longest common run moved relative to the rest.
  const stayed = keptInOrder(
    recorded.phases.map((one) => one.id).filter((id) => rule.phases.some((one) => one.id === id)),
    rule.phases.map((one) => one.id).filter((id) => recorded.phases.some((one) => one.id === id)),
  );

  for (const phase of rule.phases) {
    const index = recorded.phases.findIndex((one) => one.id === phase.id);
    const before = recorded.phases[index];

    if (before === undefined) {
      refined.push(phase.id);
      continue;
    }

    const asked =
      recorded.version === 1
        ? placedHashOf(phase, index) === before.hash
        : before.hash === phase.hash;

    if (asked && stayed.has(phase.id)) continue;

    if (!before.defined) {
      // An open phase is last wherever it is; only what it asks can change.
      if (!asked) refined.push(phase.id);
      continue;
    }

    changed.push(phase.id);

    if (phase.concessions.length <= before.concessions) unreceipted.push(phase.id);
  }

  for (const before of recorded.phases) {
    if (before.defined && !rule.phases.some((phase) => phase.id === before.id)) {
      changed.push(before.id);
      unreceipted.push(before.id);
    }
  }

  return { refined, changed, unreceipted };
};

export const PlanRootOps = { planOf, planDiffOf } as const;
