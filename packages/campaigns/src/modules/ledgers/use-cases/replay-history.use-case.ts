import type { LoadedPolicy } from "@goodbones/core";

import type { CompiledCampaign } from "../../../core/campaigns.js";
import { campaignsOf } from "../../../load/campaign-policy.js";
import { ledgerPathOf } from "../infrastructure/repositories/ledger.mapper.js";
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

    for (const objective of rule.objectives) {
      const text =
        git.textAt(commit.sha, ledgerPathOf(campaigns.ledgerDir, rule.id, objective.id)) ??
        (rule.objectives.length === 1 ? git.textAt(commit.sha, legacy) : null);

      if (text === null) continue;

      try {
        const raw = JSON.parse(text) as {
          kind?: string;
          sectors?: Record<
            string,
            { holdouts?: Array<unknown>; recorded?: number; closed?: number | null }
          >;
          entries?: Array<unknown>;
        };

        // A scalar's column is what its open sectors were held to.
        counts[objective.id] =
          raw.kind === "measure"
            ? Math.round(
                Object.values(raw.sectors ?? {})
                  .filter((one) => one.closed === null || one.closed === undefined)
                  .reduce((sum, one) => sum + (one.recorded ?? 0), 0) * 1e6,
              ) / 1e6
            : (raw.entries?.length ??
              Object.values(raw.sectors ?? {}).reduce(
                (sum, one) => sum + (one.holdouts?.length ?? 0),
                0,
              ));
      } catch {
        // an unreadable ledger at that commit contributes nothing
      }
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
