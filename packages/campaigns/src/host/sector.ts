import type { LoadedPolicy } from "@goodbones/core";

import { type CampaignEvaluation, hitsInWindow, towardNextOf } from "../core/campaign-state.js";
import { positionOf } from "../core/ledger.js";
import { isOpenPhase, type Residue as ResidueVector } from "../core/phases.js";
import { SECTOR_HOLDOUT } from "../core/sectors.js";
import { count, describeValue, measureLedgerOf, phaseIdOf, recordOf } from "./ledgers.js";

// `campaigns status --sector <name>`: where one sector stands and what holds
// it there, read off the tree and its ledgers — the question a fresh session
// or a handoff starts with, answered without a file to `explain` or a JSON
// file to read.

export type SectorView = {
  readonly campaign: string;
  readonly sector: string;
  readonly phase: {
    readonly id: string | null;
    readonly index: number;
    readonly of: number;
    readonly open: boolean;
    readonly attested: boolean;
    readonly intent: string | null;
  };
  // The furthest phase the record says it reached, and since when.
  readonly reached: string | null;
  readonly since: string | null;
  readonly attestations: ReadonlyArray<{
    readonly phase: string;
    readonly at: string;
    readonly by: string;
    readonly reason: string;
    // A concession that sent the sector back below the phase revoked it.
    readonly revoked: { readonly at: string; readonly by: string; readonly reason: string } | null;
  }>;
  readonly toward: ResidueVector;
  // Every holdout in window, by objective, with the objective's `how`.
  readonly objectives: ReadonlyArray<{
    readonly id: string;
    readonly how: string;
    readonly count: number;
    readonly holdouts: ReadonlyArray<{
      readonly file: string | null;
      readonly line: number | null;
      readonly subject: string | null;
    }>;
  }>;
  // The scalar objectives in window: the value, and what the ledger holds
  // the sector to.
  readonly measures: ReadonlyArray<{
    readonly objective: string;
    readonly value: number | null;
    readonly recorded: number | null;
    readonly target: number | null;
    readonly tolerance: number;
  }>;
  readonly notes: ReadonlyArray<{ at: string; by: string; phase: string | null; text: string }>;
};

export const sectorViewOf = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  name: string,
): SectorView | null => {
  const { rule } = evaluation;
  const state = evaluation.sectors.get(name);
  if (state === undefined) return null;
  const record = recordOf(policy, rule, name);
  const phase = rule.phases[state.phase];
  const hits = hitsInWindow(evaluation).filter((hit) => hit.sector === name);
  return {
    campaign: rule.id,
    sector: name,
    phase: {
      id: phaseIdOf(rule, state.phase),
      index: state.phase,
      of: rule.phases.length,
      open: phase !== undefined && isOpenPhase(phase),
      attested: phase?.attested === true,
      intent: phase?.intent ?? null,
    },
    reached:
      record === undefined ? null : (rule.phases[positionOf(rule, record).reached]?.id ?? null),
    since: record?.since ?? null,
    attestations: (record?.attested ?? []).map((one) => ({
      phase: one.phase,
      at: one.at,
      by: one.by,
      reason: one.reason,
      revoked: one.revoked ?? null,
    })),
    toward: towardNextOf(rule, state),
    objectives: state.inWindow
      .filter((objective) => objective.measure === null)
      .map((objective) => {
        const own = hits.filter((hit) => hit.objective === objective.id);
        return {
          id: objective.id,
          how: objective.message,
          count: own.length,
          holdouts: own
            .map((hit) =>
              hit.entry === SECTOR_HOLDOUT
                ? { file: null, line: null, subject: null }
                : {
                    file: hit.violation.file,
                    line: hit.range === undefined ? null : hit.range.start.line + 1,
                    subject: hit.violation.subject,
                  },
            )
            .sort((a, b) => {
              const byFile = (a.file ?? "").localeCompare(b.file ?? "");
              return byFile !== 0 ? byFile : (a.line ?? 0) - (b.line ?? 0);
            }),
        };
      }),
    measures: state.inWindow
      .filter((objective) => objective.measure !== null)
      .map((objective) => {
        const value = state.values[objective.id] ?? Number.NaN;
        const own = measureLedgerOf(policy, rule, objective)?.sectors[name];
        return {
          objective: objective.id,
          value: Number.isNaN(value) ? null : value,
          recorded: own === undefined || own.closed !== null ? null : own.recorded,
          target: objective.target,
          tolerance: objective.tolerance,
        };
      }),
    notes: (record?.notes ?? []).map((one) => ({ ...one })),
  };
};

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
