import type { CompiledCampaign } from "../core/campaigns.js";
import type { HistoryRow } from "../modules/ledgers/use-cases/history.result.js";
import { count } from "./lines.js";

export const renderHistory = (
  rule: CompiledCampaign,
  rows: ReadonlyArray<HistoryRow>,
): ReadonlyArray<string> => {
  if (rows.length === 0)
    return [`${rule.id}: no history — no commit has touched its ledgers or the manifest.`];
  const width = Math.max(...rule.objectives.map((one) => one.id.length), 4);

  return [
    `${rule.id}: ${count(rows.length, "commit")}`,
    "",
    `  ${"when".padEnd(10)}  ${"sha".padEnd(10)}  ${rule.objectives.map((one) => one.id.padStart(width)).join("  ")}  plan`,
    ...rows.map(
      (row) =>
        `  ${row.at.slice(0, 10)}  ${row.sha}  ${rule.objectives
          .map((one) => String(row.counts[one.id] ?? "·").padStart(width))
          .join("  ")}  ${row.planChanged ? "changed" : ""}  ${row.subject}`,
    ),
  ];
};
