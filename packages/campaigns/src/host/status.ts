import type { LoadedPolicy, SnapshotCampaign } from "@goodbones/core";

import type { CampaignEvaluation } from "../core/campaign-state.js";
import {
  isComplete,
  lastClearedOf,
  lastImprovedOf,
  measureProgressOf,
  measureSectorProgressOf,
  progressOf,
  recordedOf,
  sectorClockOf,
  sectorProgressOf,
} from "../core/ledger.js";
import { isDefinedPhase, ladderPositionOf, stepsOf } from "../core/phases.js";
import { LEGACY_SECTOR } from "../core/sectors.js";
import { count, ledgerOf, measureLedgerOf, phaseIdOf, recordOf } from "./ledgers.js";
import { campaignReportsOf } from "./report.js";

// What `campaigns` and `conformance` say of every campaign: its burn-down,
// where its sectors stand on its ladder, and the table printed from that.

// ---------------------------------------------------------------------------
// The conformance snapshot's campaigns

export const snapshotCampaignsOf = (
  policy: LoadedPolicy,
  evaluations: ReadonlyArray<CampaignEvaluation>,
): ReadonlyArray<SnapshotCampaign> =>
  campaignReportsOf(policy, evaluations).map((report, i) => {
    const evaluation = evaluations[i];
    if (evaluation === undefined) throw new Error("report without evaluation");
    const { rule } = evaluation;
    const ledgers = rule.objectives.map((objective) => ledgerOf(policy, rule, objective));
    const scalar = new Set(
      rule.objectives.filter((one) => one.measure !== null).map((one) => one.id),
    );
    const objectives = rule.objectives.map((objective, j) => {
      const ledger = ledgers[j];
      const own = report.objectives[j];
      const phase = rule.phases.find((one) => one.objectives.includes(objective.id))?.id ?? null;
      if (objective.measure !== null) {
        // A scalar: the holdout counts are all 0, and the number is under
        // `measure`. Met when every sector in window is at its target.
        const measured = measureLedgerOf(policy, rule, objective);
        const met =
          objective.target !== null &&
          (own?.sectors ?? []).every(
            (one) => (evaluation.sectors.get(one.sector)?.counts[objective.id] ?? 1) === 0,
          );
        return {
          id: objective.id,
          phase,
          initial: 0,
          allowed: 0,
          count: 0,
          cleared: 0,
          closed: 0,
          entered: Object.keys(measured?.sectors ?? {}).length,
          // No sector has entered the window: nothing has been asked yet,
          // which is not the same as done.
          progress:
            measured === undefined || Object.keys(measured.sectors).length === 0
              ? null
              : measureProgressOf(measured, objective.target),
          lastCleared: measured === undefined ? null : lastImprovedOf(measured),
          concessions: measured?.concessions.length ?? 0,
          complete: met,
          ledgered: measured !== undefined,
          measure: {
            direction: objective.direction,
            value: own?.measure?.value ?? 0,
            recorded: own?.measure?.recorded ?? (measured === undefined ? 0 : recordedOf(measured)),
            target: objective.target,
            tolerance: objective.tolerance,
          },
        };
      }
      if (ledger === undefined) {
        return {
          id: objective.id,
          phase,
          initial: own?.count ?? 0,
          allowed: 0,
          count: own?.count ?? 0,
          cleared: 0,
          closed: 0,
          entered: 0,
          progress: (own?.count ?? 0) === 0 ? null : 0,
          lastCleared: null,
          concessions: 0,
          complete: (own?.count ?? 0) === 0,
          ledgered: false,
        };
      }
      const sectors = Object.values(ledger.sectors);
      return {
        id: objective.id,
        phase,
        initial: sectors.reduce((sum, one) => sum + one.initial, 0),
        allowed: ledger.concessions.reduce(
          (sum, one) => sum + Math.max(0, "delta" in one ? one.delta : one.to - one.from),
          0,
        ),
        count: sectors.reduce((sum, one) => sum + one.holdouts.length, 0),
        cleared: sectors.reduce((sum, one) => sum + one.cleared, 0),
        closed: sectors.reduce((sum, one) => sum + one.closed, 0),
        entered: sectors.length,
        progress: sectors.length === 0 ? null : progressOf(ledger),
        lastCleared: lastClearedOf(ledger),
        concessions: ledger.concessions.length,
        complete: isComplete(ledger),
        ledgered: true,
      };
    });
    const totalInitial = objectives.reduce(
      (sum, one) => sum + one.initial + one.allowed - one.closed,
      0,
    );
    const totalCount = objectives.reduce((sum, one) => sum + one.count, 0);
    const sectors = [...evaluation.sectors.values()].filter((one) => one.name !== LEGACY_SECTOR);
    const legacy = evaluation.sectors.get(LEGACY_SECTOR);
    // Each sector's position on the ladder: the phases behind it, plus the
    // share of the one it stands in that the ledgers say is paid.
    const steps = stepsOf(rule);
    const positions = new Map(
      sectors.map((state) => [
        state.name,
        ladderPositionOf(rule, state.phase, (objectiveId) => {
          const at = rule.objectives.findIndex((one) => one.id === objectiveId);
          const objective = rule.objectives[at];
          if (objective === undefined) return 0;
          return objective.measure !== null
            ? measureSectorProgressOf(
                measureLedgerOf(policy, rule, objective),
                state.name,
                objective.target,
              )
            : sectorProgressOf(ledgers[at], state.name);
        }),
      ]),
    );
    return {
      id: rule.id,
      ...(rule.title === null ? {} : { title: rule.title }),
      ...(rule.owner === null ? {} : { owner: rule.owner }),
      count: totalCount,
      // With a ladder, how far along it the sectors stand — a number that
      // rises as they advance and never falls when one enters a phase, as
      // cleared-over-ever-ledgered does each time a new window is counted.
      progress:
        steps > 0 && sectors.length > 0
          ? [...positions.values()].reduce((sum, one) => sum + one, 0) / (steps * sectors.length)
          : totalInitial <= 0
            ? 1
            : 1 - totalCount / totalInitial,
      steps,
      objectives,
      phases: rule.phases.map((phase, index) => ({
        id: phase.id,
        defined: isDefinedPhase(phase),
        attested: phase.attested,
        sectors: sectors.filter((one) => one.phase === index).length,
      })),
      sectors: sectors.map((state) => {
        const record = recordOf(policy, rule, state.name);
        const residueTotal = Object.values(state.residue).reduce((sum, one) => sum + one, 0);
        const clock = [
          ...ledgers.flatMap((ledger) => {
            const own = ledger?.sectors[state.name];
            return own === undefined ? [] : [own.lastCleared];
          }),
          ...(record === undefined ? [] : [sectorClockOf(record)]),
        ].reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);
        return {
          name: state.name,
          phase: phaseIdOf(rule, state.phase),
          reached: record?.reached ?? null,
          files: state.sector.files.length,
          position: positions.get(state.name) ?? 0,
          residue: state.residue,
          stalled:
            rule.staleAfter !== null &&
            residueTotal > 0 &&
            clock !== null &&
            policy.now - Date.parse(clock) > rule.staleAfter,
        };
      }),
      legacy: {
        files: evaluation.index.legacy.length,
        holdouts:
          legacy === undefined
            ? 0
            : Object.entries(legacy.residue)
                .filter(([id]) => !scalar.has(id))
                .reduce((a, [, n]) => a + n, 0),
      },
      plan: report.plan,
      stalled: report.stalled,
      complete: report.complete,
      onComplete: rule.onComplete,
      ledgered: rule.objectives.every((objective, j) =>
        objective.measure === null
          ? ledgers[j] !== undefined
          : measureLedgerOf(policy, rule, objective) !== undefined,
      ),
    };
  });

// `—` for an objective no sector has entered: not 0%, and not 100%.
const percent = (fraction: number | null): string =>
  fraction === null ? "—" : `${String(Math.round(fraction * 100))}%`;

// The status table: one row per campaign, its phase distribution beneath
// when it has phases, its objectives beneath that. Stalled and complete
// first, then by progress.
export const renderCampaignRows = (
  campaigns: ReadonlyArray<SnapshotCampaign>,
): ReadonlyArray<string> => {
  const state = (one: SnapshotCampaign): string =>
    !one.ledgered ? "no ledger" : one.complete ? "complete" : one.stalled ? "stalled" : "";
  const ordered = [...campaigns].sort((left, right) => {
    const rank = (one: SnapshotCampaign): number =>
      one.stalled ? 0 : one.complete && one.ledgered ? 1 : 2;
    const byRank = rank(left) - rank(right);
    return byRank !== 0 ? byRank : left.progress - right.progress;
  });
  return ordered.flatMap((one) => {
    const width = Math.max(0, ...one.objectives.map((objective) => objective.id.length));
    return [
      `  ${one.id}  ${percent(one.progress).padStart(4)}  ${String(one.count).padStart(5)} left` +
        (one.owner === undefined ? "" : `  ${one.owner}`) +
        (state(one) === "" ? "" : `  ${state(one)}`),
      ...(one.phases.length === 0
        ? []
        : [
            `    phases: ${one.phases
              .map(
                (phase) =>
                  `${phase.id}${phase.defined ? (phase.attested ? " (attested)" : "") : " (open)"} ${String(phase.sectors)}`,
              )
              .join(" → ")}` +
              (one.legacy.files > 0 ? `  · legacy ${count(one.legacy.files, "file")}` : ""),
          ]),
      ...one.objectives.map((objective) =>
        objective.measure !== undefined
          ? `    ${objective.id.padEnd(width)}  ${percent(objective.progress).padStart(4)}  measures ${String(objective.measure.value)}, held to ${String(objective.measure.recorded)}` +
            (objective.measure.target === null
              ? ""
              : `, target ${String(objective.measure.target)}`) +
            (objective.ledgered ? "" : "  no ledger")
          : `    ${objective.id.padEnd(width)}  ${percent(objective.progress).padStart(4)}  ${String(objective.count).padStart(5)} left` +
            (objective.entered === 0 && objective.count === 0
              ? "  no sector has entered its window"
              : `  ${String(objective.cleared)} cleared  ${String(objective.allowed)} conceded` +
                (objective.closed > 0 ? `  ${String(objective.closed)} closed` : "")) +
            (objective.ledgered ? "" : "  no ledger"),
      ),
    ];
  });
};
