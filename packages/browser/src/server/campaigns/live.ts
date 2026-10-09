import {
  campaignReportsOf,
  campaignsExtension,
  campaignsOf,
  evaluateCampaigns,
  gitPathsOf,
  loadCampaignFunctions,
  makeReportSourceLive,
  type Nudge,
  nudgeOf,
  readDiff,
  reportSpecsOf,
  widenedExtensions,
} from "@goodbones/campaigns";
import type { LoadedPolicy } from "@goodbones/core";

import { campaignViewOf } from "../../model/campaigns.js";
import type { CampaignsFamily } from "./host.js";

// The campaigns family as the browser runs it, over `@goodbones/campaigns`.
// The one server module that loads the package: the composition root imports
// it through `importOptional`, so its absence is `none`, not a crash.

// The nudge for the working tree against HEAD, or nothing where git does
// not answer — a repository with no commits, or none at all.
const nudgeFor = (
  policy: LoadedPolicy,
  evaluations: Parameters<typeof nudgeOf>[1],
): Nudge | null => {
  if (campaignsOf(policy).campaignRules.length === 0) return null;
  try {
    const diff = readDiff(policy.repoRoot, null);
    return nudgeOf(policy, evaluations, diff, null, null, null);
  } catch {
    return null;
  }
};

export const liveCampaigns: CampaignsFamily = {
  host: {
    widenedExtensions,
    readReports: async (policy) => {
      const { campaignRules, reports } = campaignsOf(policy);
      await Promise.all(reportSpecsOf(campaignRules).map((spec) => reports.read?.(spec)));
    },
    view: (request) => {
      const { factsOf, policy, textOf } = request;
      const evaluations = evaluateCampaigns(policy, request.roots, request.walked, {
        textOf,
        factsOf,
      });
      return campaignViewOf({
        policy,
        name: request.name,
        evaluations,
        reports: campaignReportsOf(policy, evaluations),
        manifest: request.manifest,
        locate: request.locate,
        manifestPath: request.manifestPath,
        nudge: request.nudge ? nudgeFor(policy, evaluations) : null,
        now: policy.now,
      });
    },
    gitPaths: gitPathsOf,
  },
  // The `fn` terms are imported here, before the policy loads: the core
  // receives the functions as a map and touches no module loader.
  compose: async (repoRoot, configPath, manifest) => {
    const loaded = await loadCampaignFunctions(configPath, manifest);
    return {
      manifest: loaded.manifest,
      extensions: [
        campaignsExtension({
          functions: loaded.functions,
          reports: makeReportSourceLive(repoRoot),
        }),
      ],
      uninstalled: [],
    };
  },
};
