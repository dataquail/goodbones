import type { LoadedPolicy, Violation } from "@goodbones/core";

import {
  type CampaignEvaluation,
  hitsInWindow,
  type ObjectiveHit,
} from "../core/campaign-state.js";
import type { CompiledCampaign, CompiledObjective } from "../core/campaigns.js";
import {
  isComplete,
  isStalled,
  lastImprovedOf,
  ledgerArithmeticHolds,
  type MeasureLedger,
  measureLedgerArithmeticHolds,
  measureStandingOf,
  planDiffOf,
  reconcileSector,
  sectorArithmeticHolds,
  sectorClockOf,
  type SectorRecord,
} from "../core/ledger.js";
import type { Residue as ResidueVector } from "../core/phases.js";
import { campaignsOf } from "../load/extension.js";
import { growsFor } from "./ledger-phase.js";
import {
  count,
  describeValue,
  entriesOf,
  ledgerOf,
  measureLedgerOf,
  phaseIdOf,
  recordOf,
  sectorNames,
} from "./ledgers.js";

// ---------------------------------------------------------------------------
// The report `check` reads

export type SectorObjectiveReport = {
  readonly sector: string;
  readonly count: number;
  // Entries the ledger does not carry — unrecorded growth.
  readonly new: ReadonlyArray<string>;
  // Holdouts no entry produces — cleared, and waiting for `clear`.
  readonly stale: ReadonlyArray<string>;
  readonly drifted: number;
  // The sector is in the objective's window and the ledger has not seen it.
  readonly unrecorded: boolean;
  readonly arithmetic: boolean;
  // For a scalar objective: the value measured, the value the ledger holds
  // the sector to (`null` before `clear` records it), and where the one
  // stands against the other.
  readonly measure?: {
    readonly value: number | null;
    readonly recorded: number | null;
    readonly standing: "within" | "breached" | "surpassed" | "unrecorded" | "unmeasured";
  };
};

export type ObjectiveReport = {
  readonly id: string;
  readonly count: number;
  readonly ledgered: boolean;
  readonly sectors: ReadonlyArray<SectorObjectiveReport>;
  // For a scalar objective: its number across the sectors in window.
  readonly measure?: {
    readonly direction: "down" | "up";
    readonly value: number | null;
    readonly recorded: number | null;
    readonly target: number | null;
    readonly tolerance: number;
  };
};

export type SectorReport = {
  readonly name: string;
  readonly phase: string | null;
  readonly reached: string | null;
  readonly files: number;
  readonly residue: ResidueVector;
};

export type CampaignReport = {
  readonly id: string;
  // Holdouts in window, every objective and sector summed.
  readonly count: number;
  readonly new: ReadonlyArray<{ objective: string; sector: string; entry: string }>;
  readonly stale: ReadonlyArray<{ objective: string; sector: string; entry: string }>;
  readonly drifted: number;
  // No ledger for an objective with hits, or a sector in window the ledger
  // has not seen: `objectives clear` has not been run.
  readonly missingLedger: boolean;
  // Scalar objectives that measured no number in a sector in window: a
  // function that answered something else, a command that did not run.
  readonly unmeasured: ReadonlyArray<{ objective: string; sector: string }>;
  readonly arithmetic: boolean;
  readonly complete: boolean;
  readonly stalled: boolean;
  readonly onComplete: "keep" | "remove";
  readonly objectives: ReadonlyArray<ObjectiveReport>;
  readonly sectors: ReadonlyArray<SectorReport>;
  // Files two sectors claim.
  readonly drift: ReadonlyArray<{ readonly file: string; readonly sectors: ReadonlyArray<string> }>;
  readonly plan: {
    refined: ReadonlyArray<string>;
    changed: ReadonlyArray<string>;
    unreceipted: ReadonlyArray<string>;
  };
};

export const campaignReportsOf = (
  policy: LoadedPolicy,
  evaluations: ReadonlyArray<CampaignEvaluation>,
): ReadonlyArray<CampaignReport> =>
  evaluations.map((evaluation) => {
    const { rule } = evaluation;
    const counted = hitsInWindow(evaluation);
    let missingLedger = false;
    const unmeasured: Array<{ objective: string; sector: string }> = [];
    const scalarNew: Array<{ objective: string; sector: string; entry: string }> = [];
    const scalarStale: Array<{ objective: string; sector: string; entry: string }> = [];
    // A scalar objective, reconciled per sector against its ledger. A value
    // worse than the record past the tolerance is growth `concede` records;
    // better past it, progress `clear` records — each a line of the same
    // `new` and `stale` lists a holdout lands in, so `check` fails on them
    // for the same reasons and says the same next step. A rise in a phase
    // that `grows` the objective is on the `clear` side: the plan expected
    // it, and the ledger is only behind.
    const scalarReport = (objective: CompiledObjective): ObjectiveReport => {
      const ledger = measureLedgerOf(policy, rule, objective);
      const sectors: Array<SectorObjectiveReport> = [];
      let value = 0;
      let recorded = 0;
      let measuredAll = true;
      let recordedAll = true;
      for (const name of sectorNames(evaluation)) {
        const state = evaluation.sectors.get(name);
        if (state === undefined) continue;
        const measured = state.values[objective.id] ?? Number.NaN;
        const own = ledger?.sectors[name];
        if (!state.inWindow.some((one) => one.id === objective.id)) {
          // Past the window: a record still open is closed by `clear`.
          if (own?.closed === null) {
            scalarStale.push({
              objective: objective.id,
              sector: name,
              entry: `left the window at ${describeValue(measured)}`,
            });
          }
          continue;
        }
        if (Number.isNaN(measured)) {
          measuredAll = false;
          unmeasured.push({ objective: objective.id, sector: name });
        } else value += measured;
        if (ledger === undefined || own === undefined || own.closed !== null) {
          missingLedger = true;
          recordedAll = false;
          sectors.push({
            sector: name,
            count: 0,
            new: [],
            stale: [],
            drifted: 0,
            unrecorded: true,
            arithmetic: true,
            measure: {
              value: Number.isNaN(measured) ? null : measured,
              recorded: null,
              standing: Number.isNaN(measured) ? "unmeasured" : "unrecorded",
            },
          });
          continue;
        }
        recorded += own.recorded;
        const standing = Number.isNaN(measured)
          ? "unmeasured"
          : measureStandingOf(ledger, name, measured, objective.tolerance);
        const grown = standing === "breached" && growsFor(policy, rule, name, objective.id);
        const line =
          `measured ${describeValue(measured)}, recorded ${String(own.recorded)}` +
          (grown ? " — a rise its phase grows" : "");
        if (standing === "breached" && !grown) {
          scalarNew.push({ objective: objective.id, sector: name, entry: line });
        }
        if (standing === "surpassed" || grown) {
          scalarStale.push({ objective: objective.id, sector: name, entry: line });
        }
        sectors.push({
          sector: name,
          count: 0,
          new: standing === "breached" && !grown ? [line] : [],
          stale: standing === "surpassed" || grown ? [line] : [],
          drifted: 0,
          unrecorded: false,
          arithmetic: measureLedgerArithmeticHolds(ledger),
          measure: {
            value: Number.isNaN(measured) ? null : measured,
            recorded: own.recorded,
            standing,
          },
        });
      }
      // Sectors the ledger records that the code no longer births: closed
      // on the next `clear`, stale until then.
      for (const [name, own] of Object.entries(ledger?.sectors ?? {})) {
        if (evaluation.sectors.has(name) || own.closed !== null) continue;
        scalarStale.push({ objective: objective.id, sector: name, entry: "no longer a sector" });
      }
      return {
        id: objective.id,
        count: 0,
        ledgered: ledger !== undefined,
        sectors,
        measure: {
          direction: objective.direction,
          value: measuredAll ? value : null,
          recorded: recordedAll ? recorded : null,
          target: objective.target,
          tolerance: objective.tolerance,
        },
      };
    };
    const objectives: Array<ObjectiveReport> = rule.objectives.map((objective) => {
      if (objective.measure !== null) return scalarReport(objective);
      const ledger = ledgerOf(policy, rule, objective);
      const sectors: Array<SectorObjectiveReport> = [];
      for (const name of sectorNames(evaluation)) {
        const state = evaluation.sectors.get(name);
        if (state === undefined) continue;
        const inWindow = state.inWindow.some((one) => one.id === objective.id);
        const entries = entriesOf(counted, objective.id, name);
        const recorded = ledger?.sectors[name] !== undefined;
        if (!inWindow) {
          // Past the window: what the ledger still carries is closed by
          // `clear`, and nothing here counts.
          const carried = ledger?.sectors[name]?.holdouts ?? [];
          if (ledger !== undefined && carried.length > 0) {
            sectors.push({
              sector: name,
              count: 0,
              new: [],
              stale: carried,
              drifted: 0,
              unrecorded: false,
              arithmetic: sectorArithmeticHolds(ledger, name),
            });
          }
          continue;
        }
        if (ledger === undefined || !recorded) {
          if (entries.length > 0 || ledger !== undefined) missingLedger = true;
          sectors.push({
            sector: name,
            count: entries.length,
            new: [...new Set(entries)].sort(),
            stale: [],
            drifted: 0,
            unrecorded: true,
            arithmetic: true,
          });
          continue;
        }
        const state_ = reconcileSector(ledger, name, entries, objective.unit);
        sectors.push({
          sector: name,
          count: entries.length,
          new: state_.unrecorded,
          stale: state_.stale,
          drifted: state_.drifted.length,
          unrecorded: false,
          arithmetic: sectorArithmeticHolds(ledger, name),
        });
      }
      // Sectors the ledger carries that the code no longer births: closed
      // on the next `clear`, stale until then.
      for (const name of Object.keys(ledger?.sectors ?? {})) {
        if (evaluation.sectors.has(name)) continue;
        const holdouts = ledger?.sectors[name]?.holdouts ?? [];
        if (holdouts.length === 0) continue;
        sectors.push({
          sector: name,
          count: 0,
          new: [],
          stale: holdouts,
          drifted: 0,
          unrecorded: false,
          arithmetic: true,
        });
      }
      return {
        id: objective.id,
        count: sectors.reduce((sum, one) => sum + one.count, 0),
        ledgered: ledger !== undefined,
        sectors,
      };
    });
    const flat = (pick: (one: SectorObjectiveReport) => ReadonlyArray<string>) =>
      objectives.flatMap((objective) =>
        objective.sectors.flatMap((one) =>
          pick(one).map((entry) => ({ objective: objective.id, sector: one.sector, entry })),
        ),
      );
    const ledgers = rule.objectives.flatMap((objective) => {
      const ledger = ledgerOf(policy, rule, objective);
      return ledger === undefined ? [] : [ledger];
    });
    const measureLedgers = rule.objectives.flatMap((objective) => {
      const ledger = measureLedgerOf(policy, rule, objective);
      return ledger === undefined ? [] : [{ objective, ledger }];
    });
    // A targeted scalar is met in every sector in window when its distance
    // is 0 there; a standing one never holds a campaign open.
    const scalarsMet = rule.objectives
      .filter((objective) => objective.measure !== null && objective.target !== null)
      .every((objective) =>
        [...evaluation.sectors.values()].every(
          (state) =>
            !state.inWindow.some((one) => one.id === objective.id) ||
            (state.counts[objective.id] ?? 0) === 0,
        ),
      );
    const scalarsOpen = measureLedgers.filter(
      ({ objective }) =>
        objective.target !== null &&
        [...evaluation.sectors.values()].some(
          (state) =>
            state.inWindow.some((one) => one.id === objective.id) &&
            (state.counts[objective.id] ?? 0) > 0,
        ),
    );
    const sectorClock = [...evaluation.sectors.keys()]
      .map((name) => recordOf(policy, rule, name))
      .filter((one): one is SectorRecord => one !== undefined)
      .map(sectorClockOf)
      .reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);
    const count = objectives.reduce((sum, one) => sum + one.count, 0);
    return {
      id: rule.id,
      count,
      new: [...flat((one) => (one.measure === undefined ? one.new : [])), ...scalarNew],
      stale: [...flat((one) => (one.measure === undefined ? one.stale : [])), ...scalarStale],
      drifted: objectives.reduce(
        (sum, one) => sum + one.sectors.reduce((inner, two) => inner + two.drifted, 0),
        0,
      ),
      missingLedger,
      unmeasured,
      arithmetic:
        ledgers.every(ledgerArithmeticHolds) &&
        measureLedgers.every(({ ledger }) => measureLedgerArithmeticHolds(ledger)),
      complete: count === 0 && ledgers.every(isComplete) && scalarsMet && unmeasured.length === 0,
      stalled:
        (ledgers.length > 0 &&
          ledgers.some((ledger) => isStalled(rule, ledger, policy.now, sectorClock))) ||
        scalarsOpen.some(({ ledger }) => isMeasureStalled(rule, ledger, policy.now, sectorClock)),
      onComplete: rule.onComplete,
      objectives,
      sectors: [...evaluation.sectors.values()].map((state) => ({
        name: state.name,
        phase: phaseIdOf(rule, state.phase),
        reached: recordOf(policy, rule, state.name)?.reached ?? null,
        files: state.sector.files.length,
        residue: state.residue,
      })),
      drift: evaluation.index.drift,
      plan: planDiffOf(rule, campaignsOf(policy).plans.get(rule.id)),
    };
  });

// A scalar short of its target is stalled when its record has not improved,
// and no sector has been attested or noted, within the campaign's
// `staleAfter`.
const isMeasureStalled = (
  rule: CompiledCampaign,
  ledger: MeasureLedger,
  now: number,
  sectorClock: string | null,
): boolean => {
  if (rule.staleAfter === null) return false;
  const last = [lastImprovedOf(ledger), sectorClock]
    .filter((one): one is string => one !== null)
    .reduce((a, b) => (a > b ? a : b), ledger.created);
  return now - Date.parse(last) > rule.staleAfter;
};

// Which hits in window are carried by a ledger, exactly or by anchor.
export const ledgeredFilter = (
  policy: LoadedPolicy,
  evaluations: ReadonlyArray<CampaignEvaluation>,
): ((hit: ObjectiveHit) => boolean) => {
  const carried = new Set<ObjectiveHit>();
  for (const evaluation of evaluations) {
    const { rule } = evaluation;
    for (const objective of rule.objectives) {
      const ledger = ledgerOf(policy, rule, objective);
      if (ledger === undefined) continue;
      for (const name of sectorNames(evaluation)) {
        const own = hitsInWindow(evaluation).filter(
          (hit) => hit.objective === objective.id && hit.sector === name,
        );
        const { ledgered } = reconcileSector(
          ledger,
          name,
          own.map((hit) => hit.entry),
          objective.unit,
        );
        const known = new Set(ledgered);
        for (const hit of own) if (known.has(hit.entry)) carried.add(hit);
      }
    }
  }
  return (hit) => carried.has(hit);
};

// Why a campaign report is not ok, in the order `check` explains it.
export const campaignFailuresOf = (
  campaigns: ReadonlyArray<CampaignReport>,
): ReadonlyArray<string> => [
  ...campaigns
    .filter((one) => one.drift.length > 0)
    .map((one) => `campaign ${one.id}: a file is in two sectors`),
  ...campaigns
    .filter((one) => one.plan.unreceipted.length > 0)
    .map((one) => `campaign ${one.id}: a defined phase changed without a concession`),
  ...campaigns
    .filter((one) => one.unmeasured.length > 0)
    .map((one) => `campaign ${one.id}: a scalar objective measured no number`),
  ...campaigns.filter((one) => one.stale.length > 0).map(() => "stale ledger entries"),
  ...campaigns.filter((one) => !one.arithmetic).map(() => "ledger arithmetic does not hold"),
  ...campaigns.filter((one) => one.missingLedger).map((one) => `campaign ${one.id} has no ledger`),
  ...campaigns
    .filter((one) => !one.missingLedger && one.new.length > 0)
    .map(() => "unrecorded campaign growth"),
  ...campaigns
    .filter((one) => one.complete && !one.missingLedger && one.onComplete === "remove")
    .map((one) => `campaign ${one.id} is complete and declared onComplete: remove`),
];

// A campaign's failures, as `check` prints them, with the command that
// answers each.
export const renderCampaignReports = (
  reports: ReadonlyArray<CampaignReport>,
  hits: ReadonlyArray<{
    readonly violation: Violation;
    readonly objective: string;
    readonly sector: string;
    readonly entry: string;
    readonly ledgered: boolean;
  }>,
): ReadonlyArray<string> =>
  reports.flatMap((campaign): ReadonlyArray<string> => {
    const lines: Array<string> = [];
    const say = (...more: ReadonlyArray<string>): void => {
      for (const one of more) lines.push(one);
    };
    const at = (objective: string, sector: string, entry: string): string =>
      `  ${objective} · ${sector} · ${entry}`;
    if (campaign.drift.length > 0) {
      say(
        "",
        `campaign ${campaign.id}: ${count(campaign.drift.length, "file is", "files are")} in two sectors. A perimeter nests another; narrow one:`,
        ...campaign.drift.map((one) => `  ${one.file}  (${one.sectors.join(", ")})`),
      );
    }
    if (campaign.plan.unreceipted.length > 0) {
      say(
        "",
        `campaign ${campaign.id}: ${count(campaign.plan.unreceipted.length, "defined phase")} changed since the last clear with no concession: ${campaign.plan.unreceipted.join(", ")}. Add a \`concessions\` entry to the phase with a reason and a date, then run \`objectives clear\`.`,
      );
    }
    if (campaign.missingLedger) {
      const unrecorded = campaign.objectives.flatMap((objective) =>
        objective.sectors
          .filter(
            (one) =>
              one.unrecorded && (one.count > 0 || objective.ledgered || one.measure !== undefined),
          )
          .map(
            (one) =>
              `  ${objective.id} · ${one.sector}  (${
                one.measure === undefined
                  ? count(one.count, "hit")
                  : `measures ${one.measure.value === null ? "no number" : String(one.measure.value)}`
              })`,
          ),
      );
      say(
        "",
        `campaign ${campaign.id}: ${count(unrecorded.length, "sector")} in an objective's window that no ledger has seen. Record them before they count as growth:`,
        ...unrecorded,
        "",
        `  architecture objectives clear ${campaign.id}`,
      );
    }
    if (campaign.unmeasured.length > 0) {
      say(
        "",
        `campaign ${campaign.id}: ${count(campaign.unmeasured.length, "sector")} where a scalar objective measured no number — a function that answered something other than a number of zero or more, or a command that did not run or printed none:`,
        ...campaign.unmeasured.map((one) => `  ${one.objective} · ${one.sector}`),
      );
    }
    if (campaign.new.length > 0 && !campaign.missingLedger) {
      say(
        "",
        `campaign ${campaign.id}: ${count(campaign.new.length, "new hit")} the ledger does not carry. Fix them, or record why the count may rise:`,
        ...campaign.new.flatMap((one) => {
          const hit = hits.find(
            (two) =>
              two.objective === one.objective &&
              two.sector === one.sector &&
              two.entry === one.entry,
          );
          return [
            at(one.objective, one.sector, one.entry),
            ...(hit === undefined ? [] : [`      ${hit.violation.file}: ${hit.violation.message}`]),
          ];
        }),
        "",
        `  architecture objectives concede ${campaign.id} --reason "<why>"`,
      );
    }
    if (campaign.stale.length > 0) {
      say(
        "",
        `campaign ${campaign.id}: ${count(campaign.stale.length, "ledger entry", "ledger entries")} no longer fire, or fire past their window. The code was fixed, or the sector moved on; clear them:`,
        ...campaign.stale.map((one) => at(one.objective, one.sector, one.entry)),
        "",
        `  architecture objectives clear ${campaign.id}`,
      );
    }
    if (!campaign.arithmetic) {
      say(
        "",
        `campaign ${campaign.id}: a ledger does not add up (holdouts ≠ initial + conceded − cleared − closed; for a scalar, recorded ≠ initial + risen − improved). The ledger was edited by hand; restore it, or record the change with \`objectives concede\`.`,
      );
    }
    const complete = campaign.complete && !campaign.missingLedger;
    if (complete && campaign.onComplete === "remove") {
      say(
        "",
        `campaign ${campaign.id} is complete and declares onComplete: remove. Delete it from the manifest, and its ledgers.`,
      );
    }
    if (campaign.stalled) {
      say(
        "",
        `notice: campaign ${campaign.id} has stalled — nothing has left a ledger, and no sector has been attested or noted, within its staleAfter.`,
      );
    }
    if (complete && campaign.onComplete === "keep") {
      say("", `notice: campaign ${campaign.id} is complete, and stays as a guard.`);
    }
    if (campaign.plan.changed.length > 0 && campaign.plan.unreceipted.length === 0) {
      say(
        "",
        `notice: campaign ${campaign.id}: plan changed — ${campaign.plan.changed.join(", ")} (receipted; the next clear re-baselines the sectors in window).`,
      );
    }
    if (campaign.plan.refined.length > 0) {
      say(
        "",
        `notice: campaign ${campaign.id}: plan refined — ${campaign.plan.refined.join(", ")}.`,
      );
    }
    return lines;
  });
