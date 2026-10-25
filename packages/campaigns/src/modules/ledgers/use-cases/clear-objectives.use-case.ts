import type { LoadedPolicy } from "@goodbones/core";

import { type CampaignEvaluation, hitsInWindow } from "../../../core/campaign-state.js";
import type { CompiledObjective } from "../../../core/campaigns.js";
import { isBehind, ledgeredFor } from "../../../core/phases.js";
import { isShared, LEGACY_SECTOR } from "../../../core/sectors.js";
import type { PhaseRule } from "../../../domain/config.js";
import { campaignsOf } from "../../../load/campaign-policy.js";
import { EMPTY_LEDGER, type Ledger } from "../domain/ledger/ledger.root.js";
import {
  clearedSector,
  rebaselinedSector,
  reconcileSector,
} from "../domain/ledger/ledger.root-ops.js";
import { EMPTY_MEASURE_LEDGER } from "../domain/measure-ledger/measure-ledger.root.js";
import {
  clearedMeasure,
  concededMeasure,
  measureStandingOf,
  recordedOf,
} from "../domain/measure-ledger/measure-ledger.root-ops.js";
import { planDiffOf, planOf } from "../domain/plan/plan.root-ops.js";
import { EMPTY_SECTOR_RECORD } from "../domain/sector-record/sector-record.root.js";
import { reachedRecord } from "../domain/sector-record/sector-record.root-ops.js";
import {
  entriesOf,
  growsFor,
  ledgerOf,
  ledgerPhaseOf,
  measureLedgerOf,
  recordOf,
} from "../domain/services/campaign-ledgers.service.js";
import type { ClearOutcome } from "./clear-objectives.result.js";

// `objectives clear`: the ledgers reconciled with the code wherever that is
// not a regression, the furthest phase each sector has reached, and the plan.

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
  const campaigns = campaignsOf(policy);
  const existing = measureLedgerOf(campaigns, rule, objective);

  const before =
    existing ?? EMPTY_MEASURE_LEDGER(rule.id, objective.id, objective.direction, policy.now);

  let ledger = before;
  const entered: Array<string> = [];
  const rebaselined: Array<string> = [];
  const improved: Array<{ sector: string; from: number; to: number }> = [];
  const grown: Array<{ sector: string; from: number; to: number; phase: string | null }> = [];
  let closed = 0;

  for (const [name, state] of evaluation.sectors) {
    if (!ledgeredFor(rule, objective, name)) continue;
    const value = state.values[objective.id] ?? Number.NaN;
    const own = ledger.sectors[name];

    if (!state.inWindow.some((one) => one.id === objective.id)) {
      // Behind the window, the record is held for the sector's return.
      if (isBehind(rule, objective, state.phase, state.position)) continue;
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

    if (
      growsFor(campaigns, rule, name, objective.id) &&
      measureStandingOf(ledger, name, value, objective.tolerance) === "breached"
    ) {
      // On the shared files, which hold no number; elsewhere, in a phase that
      // grows this one.
      const at = isShared(rule, name)
        ? null
        : (rule.phases[ledgerPhaseOf(campaigns, rule, name)]?.id ?? null);

      ledger = concededMeasure(ledger, name, value, {
        at: policy.now,
        by,
        reason:
          at === null
            ? `the shared files hold no number: ${objective.id} is measured there`
            : `phase ${at} grows ${objective.id}`,
      });
      grown.push({ sector: name, from: own.recorded, to: value, phase: at });
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
    campaigns.repositories.ledgers.save(ledger);
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
export const clearObjectivesUseCase = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  only: string | null,
  by: string,
): ReadonlyArray<ClearOutcome> => {
  const { rule } = evaluation;
  const campaigns = campaignsOf(policy);
  const counted = hitsInWindow(evaluation);
  const plan = planDiffOf(rule, campaigns.plans.get(rule.id));
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
      ledgerOf(campaigns, rule, objective) ?? EMPTY_LEDGER(rule.id, objective.id, policy.now);

    let ledger = before;
    const entered: Array<string> = [];
    const rebaselined: Array<string> = [];
    let rewritten = 0;

    for (const [name, state] of evaluation.sectors) {
      if (!ledgeredFor(rule, objective, name)) continue;
      const inWindow = state.inWindow.some((one) => one.id === objective.id);
      const entries = entriesOf(counted, objective.id, name);

      if (!inWindow) {
        // Behind the window — a regression sent the sector below the phase
        // naming it — the holdouts are work still owed: held, not closed,
        // so its initial, what it cleared and what was conceded survive.
        if (isBehind(rule, objective, state.phase, state.position)) continue;
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

    if (ledger !== before || ledgerOf(campaigns, rule, objective) === undefined) {
      campaigns.repositories.ledgers.save(ledger);
    }
  }

  if (only === null) {
    for (const [name, state] of evaluation.sectors) {
      // Neither stands on the ladder, so neither has a record of reaching.
      if (name === LEGACY_SECTOR || isShared(rule, name)) continue;

      const before =
        recordOf(campaigns, rule, name) ?? EMPTY_SECTOR_RECORD(rule.id, name, policy.now);

      const after = reachedRecord(before, rule, state.phase, policy.now);

      if (after !== before || recordOf(campaigns, rule, name) === undefined) {
        campaigns.repositories.sectorRecords.save(after);
      }
    }

    campaigns.repositories.plans.save(planOf(rule));

    if (campaigns.legacyLedgers.has(rule.id)) {
      campaigns.repositories.ledgers.remove({ campaign: rule.id, objective: null });
    }
  }

  return outcomes;
};
