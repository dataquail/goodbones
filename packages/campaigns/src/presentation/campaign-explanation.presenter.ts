import {
  describeValue,
  HOLDOUT_CAP,
} from "../modules/ledgers/domain/services/campaign-ledgers.service.js";
import type { CampaignExplanation } from "../modules/ledgers/use-cases/campaign-explanation.result.js";

// The explain paragraph.
export const renderCampaignExplanation = (
  explained: CampaignExplanation,
): ReadonlyArray<string> => {
  const { campaign, phase, sector } = explained;
  const intent = phase?.intent ?? null;

  const at = explained.shared
    ? " — held by every sector, on no phase"
    : campaign.phases === 0
      ? ""
      : ` — phase ${phase?.id ?? "done"} (${String(explained.index + 1)} of ${String(campaign.phases)}${phase?.open === true ? ", open" : phase?.attested === true ? ", attested" : ""})`;

  return [
    `    ${campaign.name}: sector ${sector}${at}${explained.reached === null ? "" : `, reached ${explained.reached}`}`,
    ...(intent === null ? [] : [`      intent: ${intent}`]),
    ...(phase?.attested === true
      ? [
          `      attested, not detected: architecture campaigns attest ${sector} ${phase.id} --reason "…" --campaign ${campaign.id}`,
        ]
      : []),
    `      in window: ${explained.inWindow.length === 0 ? "(nothing)" : explained.inWindow.map((one) => `${one.id}${one.firing ? " ✗" : ""}`).join(", ")}`,
    ...explained.measures.map(
      (one) =>
        `      ${one.id}: the sector measures ${describeValue(one.value)}${one.recorded === null ? ", unrecorded" : `, held to ${String(one.recorded)}`}${one.target === null ? "" : `, target ${String(one.target)}`}`,
    ),
    ...(explained.holdouts.length === 0
      ? []
      : [
          `      nearest holdouts in this file:`,
          ...explained.holdouts
            .slice(0, HOLDOUT_CAP)
            .map(
              (hit) =>
                `        ${hit.line === null ? "" : `:${String(hit.line)}  `}${hit.objective}${hit.subject === null ? "" : `  ${hit.subject}`}`,
            ),
        ]),
  ];
};
