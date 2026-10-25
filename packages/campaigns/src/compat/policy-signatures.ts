import type { LoadedPolicy } from "@goodbones/core";
import * as Result from "effect/Result";

import type { CampaignEvaluation, ObjectiveHit } from "../core/campaign-state.js";
import type { CompiledCampaign, CompiledObjective } from "../core/campaigns.js";
import { campaignsOf } from "../load/campaign-policy.js";
import {
  growsFor as growsForLedgers,
  type LedgerOverrides,
  ledgerPhaseOf as ledgerPhaseOfLedgers,
} from "../modules/ledgers/domain/services/campaign-ledgers.service.js";
import { ledgeredFilterOf } from "../modules/ledgers/domain/services/campaign-report.service.js";
import {
  type ConcessionReceipt,
  sendBackOf,
  type SentBack,
} from "../modules/ledgers/domain/services/concession.service.js";
import type { ConcedeOutcome } from "../modules/ledgers/use-cases/concede-objective.result.js";
import { concedeObjectiveUseCase } from "../modules/ledgers/use-cases/concede-objective.use-case.js";
import { explainCampaignUseCase } from "../modules/ledgers/use-cases/explain-campaign.use-case.js";
import { renderCampaignExplanation } from "../presentation/campaign-explanation.presenter.js";

// The barrel's names from before the verbs were use-cases, at the
// signatures they had then: each one read the loaded policy, and so takes
// it still. A composition of a use-case or a domain service with the
// policy's state, and — for `explain` — of a use-case with its presenter,
// which is the one place the two meet. New code calls what these compose.

// Where the ledgers place a sector: the loaded ones, or `overrides`.
export const ledgerPhaseOf = (
  policy: LoadedPolicy,
  rule: CompiledCampaign,
  sector: string,
  overrides: LedgerOverrides = {},
): number => ledgerPhaseOfLedgers(campaignsOf(policy), rule, sector, overrides);

export const growsFor = (
  policy: LoadedPolicy,
  rule: CompiledCampaign,
  sector: string,
  objectiveId: string,
): boolean => growsForLedgers(campaignsOf(policy), rule, sector, objectiveId);

// Which hits in window are carried by a ledger, exactly or by anchor.
export const ledgeredFilter = (
  policy: LoadedPolicy,
  evaluations: ReadonlyArray<CampaignEvaluation>,
): ((hit: ObjectiveHit) => boolean) => ledgeredFilterOf(campaignsOf(policy), evaluations);

// The sectors the ledgers about to be written send back a phase, with the
// attestations that revokes saved to their records.
export const sendBack = (
  policy: LoadedPolicy,
  rule: CompiledCampaign,
  sectors: Iterable<string>,
  written: LedgerOverrides,
  revocation: ConcessionReceipt,
): ReadonlyArray<SentBack> => {
  const campaigns = campaignsOf(policy);
  const back = sendBackOf(campaigns, rule, sectors, written, revocation);

  for (const record of back.records) campaigns.repositories.sectorRecords.save(record);

  return back.sent;
};

// `concede` for a scalar objective, narrowed to `sector`. It reads only a
// scalar's ledger, so a holdout objective — whose ledger is of the other
// kind — has none to concede against, as it never had.
export const concedeMeasure = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  objective: CompiledObjective,
  sector: string | null,
  record: ConcessionReceipt,
): Result.Result<ConcedeOutcome, string> => {
  const { rule } = evaluation;

  if (objective.measure === null) {
    return Result.fail(
      `objective ${rule.id}/${objective.id} has no ledger yet; run \`objectives clear ${rule.id}\` first.`,
    );
  }

  return concedeObjectiveUseCase(policy, evaluation, objective.id, null, sector, record);
};

// `explain`'s paragraph for one campaign.
export const explainCampaignLines = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  file: string,
): ReadonlyArray<string> => {
  const explained = explainCampaignUseCase(policy, evaluation, file);

  return explained === null ? [] : renderCampaignExplanation(explained);
};
