import { listWorkspaceProjects, type LoadedPolicy } from "@goodbones/core";

import type { CampaignEvaluation } from "../../../core/campaign-state.js";
import { campaignsOf } from "../../../load/campaign-policy.js";
import {
  commandValuesOf,
  evaluateCampaignsOver,
  type Readers,
  readersOf,
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

  const projects = campaigns.campaignRules.some((rule) => rule.perimeter?.kind === "nx")
    ? listWorkspaceProjects(policy.repoRoot, roots)
    : [];

  return evaluateCampaignsOver(
    policy,
    campaigns,
    files,
    readers,
    projects,
    commandValuesOf(campaigns.clients.commands.outputOf),
  );
};
