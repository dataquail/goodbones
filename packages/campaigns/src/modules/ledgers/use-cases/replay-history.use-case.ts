import type { LoadedPolicy } from "@goodbones/core";
import * as Result from "effect/Result";

import type { CompiledCampaign } from "../../../core/campaigns.js";
import { campaignsOf } from "../../../load/campaign-policy.js";
import type { HistoryRow } from "./history.result.js";

// The series replayed from the ledgers' and the manifest's git history:
// a step function of human actions — every `clear`, `concede`, `attest`,
// `note` and plan edit — annotated where the plan changed.
export const replayHistoryUseCase = (
  policy: LoadedPolicy,
  rule: CompiledCampaign,
  since: string | null,
  manifestPaths: ReadonlyArray<string>,
): ReadonlyArray<HistoryRow> => {
  const campaigns = campaignsOf(policy);
  const { git } = campaigns.clients;
  const dir = `${campaigns.ledgerDir}/${rule.id}`;
  const legacy = `${campaigns.ledgerDir}/${rule.id}.json`;
  const commits = git.commitsTouching([dir, legacy, ...manifestPaths], since);

  return commits.map((commit) => {
    const counts: Record<string, number> = {};
    const { ledgers } = campaigns.readersAt(commit.sha);

    for (const objective of rule.objectives) {
      const own = ledgers.findOne({ campaign: rule.id, objective: objective.id });

      // A campaign of one objective may still be in the first layout there.
      const found =
        Result.isSuccess(own) && own.success === null && rule.objectives.length === 1
          ? ledgers.findOne({ campaign: rule.id, objective: null })
          : own;

      // An unreadable ledger at that commit contributes nothing.
      if (Result.isFailure(found) || found.success === null) continue;
      const ledger = found.success;

      // A scalar's column is what its open sectors were held to.
      counts[objective.id] =
        "kind" in ledger
          ? Math.round(
              Object.values(ledger.sectors)
                .filter((one) => one.closed === null)
                .reduce((sum, one) => sum + one.recorded, 0) * 1e6,
            ) / 1e6
          : Object.values(ledger.sectors).reduce((sum, one) => sum + one.holdouts.length, 0);
    }

    return {
      sha: commit.sha.slice(0, 10),
      at: commit.at,
      subject: commit.subject,
      counts,
      planChanged: commit.files.some((file) => manifestPaths.includes(file)),
    };
  });
};
