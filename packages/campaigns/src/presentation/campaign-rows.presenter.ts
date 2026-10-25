import type { SnapshotCampaign } from "@goodbones/core";

import { count } from "./lines.js";

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
              (one.legacy.files > 0 ? `  · legacy ${count(one.legacy.files, "file")}` : "") +
              (one.shared === undefined ? "" : `  · shared ${count(one.shared.files, "file")}`),
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
            (objective.over === undefined ? "" : "  over the shared files") +
            (objective.ledgered ? "" : "  no ledger"),
      ),
    ];
  });
};
