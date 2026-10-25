import { describeValue } from "../modules/ledgers/domain/services/campaign-ledgers.service.js";
import type { SectorView } from "../modules/ledgers/use-cases/sector-view.result.js";
import { count } from "./lines.js";

export const renderSectorView = (view: SectorView): ReadonlyArray<string> => {
  const at =
    view.phase.id === null
      ? "past every phase"
      : `phase ${view.phase.id} (${String(view.phase.index + 1)} of ${String(view.phase.of)}${view.phase.open ? ", open" : view.phase.attested ? ", attested" : ""})`;

  const lines = [
    `${view.campaign} · ${view.sector} — ${at}` +
      (view.reached === null ? ", never cleared" : `, reached ${view.reached}`) +
      (view.since === null ? "" : ` since ${view.since.slice(0, 10)}`),
  ];

  if (view.phase.intent !== null) lines.push(`  intent: ${view.phase.intent}`);

  if (view.phase.attested) {
    lines.push(
      `  this phase is attested, not detected: architecture campaigns attest ${view.sector} ${view.phase.id ?? ""} --reason "…" --campaign ${view.campaign}`,
    );
  }

  for (const one of view.attestations) {
    lines.push(
      `  attested ${one.phase}: ${one.at.slice(0, 10)} by ${one.by} — ${one.reason}` +
        (one.revoked === null
          ? ""
          : ` (revoked ${one.revoked.at.slice(0, 10)} by ${one.revoked.by}: ${one.revoked.reason})`),
    );
  }

  const toward = Object.entries(view.toward)
    .map(([id, n]) => `${id} ${String(n)}`)
    .join(" · ");

  lines.push(`  toward the next phase: ${toward === "" ? "nothing counted" : toward}`);

  const held = view.objectives
    .filter((objective) => objective.count > 0)
    .flatMap((objective) => [
      `  ${objective.id} — ${count(objective.count, "holdout")} in window: ${objective.how}`,
      ...objective.holdouts.map((h) =>
        h.file === null
          ? "    (the sector as a whole)"
          : `    ${h.file}${h.line === null ? "" : `:${String(h.line)}`}${h.subject === null ? "" : `  ${h.subject.split("#")[0] ?? ""}`}`,
      ),
    ]);

  const measured = view.measures.map((measure) => {
    const bounds = [
      ...(measure.recorded === null ? ["unrecorded"] : [`held to ${String(measure.recorded)}`]),
      ...(measure.target === null ? [] : [`target ${String(measure.target)}`]),
      ...(measure.tolerance === 0 ? [] : [`tolerance ${String(measure.tolerance)}`]),
    ];

    return `  ${measure.objective}: ${measure.value === null ? "no number" : describeValue(measure.value)} (${bounds.join(", ")})`;
  });

  const notes =
    view.notes.length === 0
      ? []
      : [
          `  notes (${String(view.notes.length)}, data):`,
          ...view.notes.map(
            (one) =>
              `    ${one.at.slice(0, 10)} ${one.by}${one.phase === null ? "" : ` at ${one.phase}`}: ${JSON.stringify(one.text)}`,
          ),
        ];

  return [...lines, ...held, ...measured, ...notes];
};
