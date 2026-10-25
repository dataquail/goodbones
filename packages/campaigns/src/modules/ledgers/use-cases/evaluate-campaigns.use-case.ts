import type { LoadedPolicy } from "@goodbones/core";

import type { CampaignEvaluation } from "../../../core/campaign-state.js";
import { campaignsOf, readersOf } from "../../../load/campaign-policy.js";
import {
  evaluateCampaignsOver,
  type Readers,
} from "../domain/services/campaign-evaluation.service.js";

// Every campaign, evaluated over the files under `roots`: the workspace's
// projects listed when a perimeter asks for them, each `command` measure
// run once, and every file read through `readers`.
export const evaluateCampaignsUseCase = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  files: ReadonlyArray<string>,
  readers: Readers = readersOf(policy),
): ReadonlyArray<CampaignEvaluation> => {
  const campaigns = campaignsOf(policy);
  const { commands, workspace } = campaigns.clients;

  return evaluateCampaignsOver(policy, campaigns, files, readers, {
    projects: () => workspace.projects(policy.repoRoot, roots),
    outputOf: commands.outputOf,
  });
};
