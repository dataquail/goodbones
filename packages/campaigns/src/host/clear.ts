import { rmSync } from "node:fs";
import * as path from "node:path";

import type { LoadedPolicy } from "@goodbones/core";

import { type CampaignEvaluation, hitsInWindow } from "../core/campaign-state.js";
import type { CompiledObjective } from "../core/campaigns.js";
import {
  clearedMeasure,
  clearedSector,
  concededMeasure,
  EMPTY_LEDGER,
  EMPTY_MEASURE_LEDGER,
  EMPTY_SECTOR_RECORD,
  type Ledger,
  ledgerPathOf,
  measureStandingOf,
  planDiffOf,
  planOf,
  planPathOf,
  reachedRecord,
  rebaselinedSector,
  reconcileSector,
  recordedOf,
  sectorRecordPathOf,
  serializeLedger,
  serializeMeasureLedger,
  serializePlanRecord,
  serializeSectorRecord,
} from "../core/ledger.js";
import { LEGACY_SECTOR } from "../core/sectors.js";
import type { PhaseRule } from "../domain/config.js";
import { campaignsOf } from "../load/extension.js";
import { ledgerPhaseOf } from "./ledger-phase.js";
import { entriesOf, ledgerOf, measureLedgerOf, recordOf, writeJson } from "./ledgers.js";

// `objectives clear`: the ledgers reconciled with the code wherever that is
// not a regression, the furthest phase each sector has reached, and the plan.

export type ClearOutcome = {
  readonly campaign: string;
  readonly objective: string;
  readonly cleared: number;
  readonly rewritten: number;
  readonly closed: number;
  readonly entered: ReadonlyArray<string>;
  readonly rebaselined: ReadonlyArray<string>;
  readonly left: number;
  // For a scalar objective: the sectors whose record improved, those whose
  // number rose in a phase that `grows` it, and what the open sectors are
  // held to now, summed. `cleared`, `rewritten` and `left` are 0; `closed`
  // counts sectors.
  readonly measure?: {
    readonly improved: ReadonlyArray<{ sector: string; from: number; to: number }>;
    readonly grown: ReadonlyArray<{ sector: string; from: number; to: number; phase: string }>;
    readonly recorded: number;
  };
};

// `clear` for a scalar objective: a sector entering the window is recorded
// at its value; one inside it whose value improved past the tolerance is
// held to that value from now; one past it, or no longer born, is closed;
// and a receipted phase change re-baselines the sectors in window to what
// they measure, with a concession. A rise is left where it is — unless the
// phase the ledgers place the sector at `grows` the objective, and then the
// rise is recorded with a concession naming the phase: the plan is the
// receipt, and the arithmetic still holds.
const clearMeasure = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  objective: CompiledObjective,
  receipted: PhaseRule | null,
  by: string,
): ClearOutcome => {
  const { rule } = evaluation;
  const existing = measureLedgerOf(policy, rule, objective);
  const before =
    existing ?? EMPTY_MEASURE_LEDGER(rule.id, objective.id, objective.direction, policy.now);
  let ledger = before;
  const entered: Array<string> = [];
  const rebaselined: Array<string> = [];
  const improved: Array<{ sector: string; from: number; to: number }> = [];
  const grown: Array<{ sector: string; from: number; to: number; phase: string }> = [];
  let closed = 0;
  for (const [name, state] of evaluation.sectors) {
    const value = state.values[objective.id] ?? Number.NaN;
    const own = ledger.sectors[name];
    if (!state.inWindow.some((one) => one.id === objective.id)) {
      const next = clearedMeasure(ledger, name, value, objective.tolerance, policy.now, "outside");
      if (next !== ledger) closed += 1;
      ledger = next;
      continue;
    }
    if (own === undefined || own.closed !== null) {
      const next = clearedMeasure(
        ledger,
        name,
        value,
        objective.tolerance,
        policy.now,
        "inside",
        by,
      );
      if (next !== ledger) entered.push(name);
      ledger = next;
      continue;
    }
    if (receipted !== null) {
      const next = concededMeasure(ledger, name, value, {
        at: policy.now,
        by,
        reason: `phase ${receipted.id} changed: ${receipted.concessions.at(-1)?.reason ?? ""}`,
      });
      if (next !== ledger) rebaselined.push(name);
      ledger = next;
      continue;
    }
    const at = rule.phases[ledgerPhaseOf(policy, rule, name)];
    if (
      at?.grows?.includes(objective.id) === true &&
      measureStandingOf(ledger, name, value, objective.tolerance) === "breached"
    ) {
      ledger = concededMeasure(ledger, name, value, {
        at: policy.now,
        by,
        reason: `phase ${at.id} grows ${objective.id}`,
      });
      grown.push({ sector: name, from: own.recorded, to: value, phase: at.id });
      continue;
    }
    const next = clearedMeasure(ledger, name, value, objective.tolerance, policy.now, "inside");
    if (next !== ledger) {
      improved.push({
        sector: name,
        from: own.recorded,
        to: next.sectors[name]?.recorded ?? own.recorded,
      });
    }
    ledger = next;
  }
  // Sectors the code no longer births are past every window.
  for (const [name, own] of Object.entries(ledger.sectors)) {
    if (evaluation.sectors.has(name) || own.closed !== null) continue;
    ledger = clearedMeasure(ledger, name, own.recorded, objective.tolerance, policy.now, "outside");
    closed += 1;
  }
  if (ledger !== before || existing === undefined) {
    writeJson(
      policy.repoRoot,
      ledgerPathOf(campaignsOf(policy).ledgerDir, rule.id, objective.id),
      serializeMeasureLedger(ledger),
    );
  }
  return {
    campaign: rule.id,
    objective: objective.id,
    cleared: 0,
    rewritten: 0,
    closed,
    entered,
    rebaselined,
    left: 0,
    measure: { improved, grown, recorded: recordedOf(ledger) },
  };
};

// `clear`: the ledger reconciled with the code wherever that is not a
// regression. Stale holdouts leave and drifted ones are rewritten; a sector
// newly in an objective's window is recorded with its initial; a sector
// past a window has its holdouts closed; a phase concession authorizes a
// re-baseline of the sectors in that phase's window; the furthest phase
// each sector has reached is recorded, and so is the plan. Unrecorded
// growth is left where it is — `concede` is the one way it enters.
export const clear = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  only: string | null,
  by: string,
): ReadonlyArray<ClearOutcome> => {
  const { rule } = evaluation;
  const counted = hitsInWindow(evaluation);
  const plan = planDiffOf(rule, campaignsOf(policy).plans.get(rule.id));
  const outcomes: Array<ClearOutcome> = [];
  for (const objective of rule.objectives) {
    if (only !== null && objective.id !== only) continue;
    const phase = rule.phases.find((one) => one.objectives.includes(objective.id));
    // The phase naming the objective, when it changed with a receipt.
    const receipted =
      phase !== undefined && plan.changed.includes(phase.id) && !plan.unreceipted.includes(phase.id)
        ? phase
        : null;
    if (objective.measure !== null) {
      outcomes.push(clearMeasure(policy, evaluation, objective, receipted, by));
      continue;
    }
    const before =
      ledgerOf(policy, rule, objective) ?? EMPTY_LEDGER(rule.id, objective.id, policy.now);
    let ledger = before;
    const entered: Array<string> = [];
    const rebaselined: Array<string> = [];
    let rewritten = 0;
    for (const [name, state] of evaluation.sectors) {
      const inWindow = state.inWindow.some((one) => one.id === objective.id);
      const entries = entriesOf(counted, objective.id, name);
      if (!inWindow) {
        ledger = clearedSector(ledger, name, entries, objective.unit, policy.now, "outside");
        continue;
      }
      if (ledger.sectors[name] === undefined) entered.push(name);
      else rewritten += reconcileSector(ledger, name, entries, objective.unit).drifted.length;
      if (receipted !== null && ledger.sectors[name] !== undefined) {
        const concession = receipted.concessions.at(-1);
        const next = rebaselinedSector(ledger, name, entries, {
          at: policy.now,
          by,
          reason: `phase ${receipted.id} changed: ${concession?.reason ?? ""}`,
        });
        if (next !== ledger) rebaselined.push(name);
        ledger = next;
        continue;
      }
      ledger = clearedSector(ledger, name, entries, objective.unit, policy.now, "inside");
    }
    // Sectors the code no longer births are past every window.
    for (const name of Object.keys(ledger.sectors)) {
      if (!evaluation.sectors.has(name)) {
        ledger = clearedSector(ledger, name, [], objective.unit, policy.now, "outside");
      }
    }
    const sum = (one: Ledger, pick: (sector: Ledger["sectors"][string]) => number): number =>
      Object.values(one.sectors).reduce((total, sector) => total + pick(sector), 0);
    outcomes.push({
      campaign: rule.id,
      objective: objective.id,
      cleared: sum(ledger, (one) => one.cleared) - sum(before, (one) => one.cleared),
      rewritten,
      closed: sum(ledger, (one) => one.closed) - sum(before, (one) => one.closed),
      entered,
      rebaselined,
      left: sum(ledger, (one) => one.holdouts.length),
    });
    if (ledger !== before || ledgerOf(policy, rule, objective) === undefined) {
      writeJson(
        policy.repoRoot,
        ledgerPathOf(campaignsOf(policy).ledgerDir, rule.id, objective.id),
        serializeLedger(ledger),
      );
    }
  }
  if (only === null) {
    for (const [name, state] of evaluation.sectors) {
      if (name === LEGACY_SECTOR) continue;
      const before = recordOf(policy, rule, name) ?? EMPTY_SECTOR_RECORD(rule.id, name, policy.now);
      const after = reachedRecord(before, rule, state.phase, policy.now);
      if (after !== before || recordOf(policy, rule, name) === undefined) {
        writeJson(
          policy.repoRoot,
          sectorRecordPathOf(campaignsOf(policy).ledgerDir, rule.id, name),
          serializeSectorRecord(after),
        );
      }
    }
    writeJson(
      policy.repoRoot,
      planPathOf(campaignsOf(policy).ledgerDir, rule.id),
      serializePlanRecord(planOf(rule)),
    );
    const legacy = campaignsOf(policy).legacyLedgers.get(rule.id);
    if (legacy !== undefined) rmSync(path.resolve(policy.repoRoot, legacy), { force: true });
  }
  return outcomes;
};
