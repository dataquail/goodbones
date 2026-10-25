import type { LoadedPolicy } from "@goodbones/core";

import type { CampaignEvaluation } from "../../../core/campaign-state.js";
import { campaignsOf } from "../../../load/campaign-policy.js";
import {
  type CampaignReport,
  campaignReportsOf,
} from "../domain/services/campaign-report.service.js";

// The report `check` reads: each campaign's evaluation judged against the
// ledgers, records and plans the policy was loaded with.
export const reportCampaignsUseCase = (
  policy: LoadedPolicy,
  evaluations: ReadonlyArray<CampaignEvaluation>,
): ReadonlyArray<CampaignReport> => campaignReportsOf(campaignsOf(policy), policy.now, evaluations);
