import type { LoadedPolicy } from "@goodbones/core";

import { type CampaignEvaluation, hitsInWindow } from "../core/campaign-state.js";
import { isOpenPhase } from "../core/phases.js";
import { isShared } from "../core/sectors.js";
import { describeValue, HOLDOUT_CAP, measureLedgerOf, recordOf } from "./ledgers.js";

// ---------------------------------------------------------------------------
// The explain paragraph

export const explainCampaignLines = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  file: string,
): ReadonlyArray<string> => {
  const { rule } = evaluation;
  const sector = evaluation.index.sectorOf(file);
  if (sector === null) return [];
  const state = evaluation.sectors.get(sector);
  if (state === undefined) return [];
  const phase = rule.phases[state.phase];
  const at = isShared(rule, sector)
    ? " — held by every sector, on no phase"
    : rule.phases.length === 0
      ? ""
      : ` — phase ${phase?.id ?? "done"} (${String(state.phase + 1)} of ${String(rule.phases.length)}${phase !== undefined && isOpenPhase(phase) ? ", open" : phase?.attested === true ? ", attested" : ""})`;
  const own = hitsInWindow(evaluation)
    .filter((hit) => hit.sector === sector && hit.violation.file === file)
    .sort((a, b) => (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0));
  const firing = new Set(own.map((hit) => hit.objective));
  const record = recordOf(policy, rule, sector);
  return [
    `    ${rule.name}: sector ${sector}${at}${record?.reached === undefined || record.reached === null ? "" : `, reached ${record.reached}`}`,
    ...(phase?.intent === undefined ? [] : [`      intent: ${phase.intent}`]),
    ...(phase?.attested === true
      ? [
          `      attested, not detected: architecture campaigns attest ${sector} ${phase.id} --reason "…" --campaign ${rule.id}`,
        ]
      : []),
    `      in window: ${state.inWindow.length === 0 ? "(nothing)" : state.inWindow.map((one) => `${one.id}${firing.has(one.id) ? " ✗" : ""}`).join(", ")}`,
    ...state.inWindow
      .filter((one) => one.measure !== null)
      .map((one) => {
        const recorded = measureLedgerOf(policy, rule, one)?.sectors[sector];
        return `      ${one.id}: the sector measures ${describeValue(state.values[one.id] ?? Number.NaN)}${recorded === undefined || recorded.closed !== null ? ", unrecorded" : `, held to ${String(recorded.recorded)}`}${one.target === null ? "" : `, target ${String(one.target)}`}`;
      }),
    ...(own.length === 0
      ? []
      : [
          `      nearest holdouts in this file:`,
          ...own
            .slice(0, HOLDOUT_CAP)
            .map(
              (hit) =>
                `        ${hit.range === undefined ? "" : `:${String(hit.range.start.line + 1)}  `}${hit.objective}${hit.violation.subject === null ? "" : `  ${hit.violation.subject}`}`,
            ),
        ]),
  ];
};
