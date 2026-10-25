import type { LoadedPolicy } from "@goodbones/core";
import * as Result from "effect/Result";

import type { CampaignEvaluation } from "../../../core/campaign-state.js";
import { campaignsOf } from "../../../load/campaign-policy.js";
import { ledgerOf, measureLedgerOf } from "../domain/services/campaign-ledgers.service.js";
import {
  concededHoldoutsOf,
  concededMeasuresOf,
  type ConcessionReceipt,
  sendBackOf,
} from "../domain/services/concession.service.js";
import type { ConcedeOutcome } from "./concede-objective.result.js";

// `objectives concede`: the unrecorded hits join the ledger — for a scalar,
// each sector in window whose number is worse than its record is held to it
// — each sector's with a concession naming the reason and the author.
// `chosen` narrows to some holdouts, `sector` to one sector. A concession
// that sends a sector back below an attested phase revokes that attestation.
export const concedeObjectiveUseCase = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  objectiveId: string,
  chosen: ReadonlyArray<string> | null,
  sector: string | null,
  receipt: ConcessionReceipt,
): Result.Result<ConcedeOutcome, string> => {
  const { rule } = evaluation;
  const campaigns = campaignsOf(policy);
  const objective = rule.objectives.find((one) => one.id === objectiveId);

  if (objective === undefined)
    return Result.fail(`no objective of ${rule.id} is named "${objectiveId}"`);

  const unledgered = Result.fail(
    `objective ${rule.id}/${objectiveId} has no ledger yet; run \`objectives clear ${rule.id}\` first.`,
  );

  const revocation = { ...receipt, reason: `conceded ${objective.id}: ${receipt.reason}` };

  if (objective.measure !== null) {
    if (chosen !== null) {
      return Result.fail(
        `${rule.id}/${objectiveId} is a scalar objective: it has no holdouts to choose among. Narrow with --sector.`,
      );
    }

    const ledger = measureLedgerOf(campaigns, rule, objective);

    if (ledger === undefined) return unledgered;
    const done = concededMeasuresOf(ledger, evaluation, objective, sector, receipt);

    if (done.conceded.length > 0) campaigns.repositories.ledgers.save(done.ledger);

    const back = sendBackOf(
      campaigns,
      rule,
      done.conceded.map((one) => one.sector),
      { measures: new Map([[objective.id, done.ledger]]) },
      revocation,
    );

    for (const record of back.records) campaigns.repositories.sectorRecords.save(record);

    return Result.succeed({
      objective: objective.id,
      conceded: done.conceded,
      left: done.left,
      sentBack: back.sent,
    });
  }

  const ledger = ledgerOf(campaigns, rule, objective);

  if (ledger === undefined) return unledgered;
  const done = concededHoldoutsOf(ledger, evaluation, objective, chosen, sector, receipt);

  if (Result.isFailure(done)) return Result.fail(done.failure);
  const { conceded, left } = done.success;

  if (conceded.length > 0) campaigns.repositories.ledgers.save(done.success.ledger);

  const back = sendBackOf(
    campaigns,
    rule,
    conceded.map((one) => one.sector),
    { ledgers: new Map([[objective.id, done.success.ledger]]) },
    revocation,
  );

  for (const record of back.records) campaigns.repositories.sectorRecords.save(record);

  return Result.succeed({ objective: objectiveId, conceded, left, sentBack: back.sent });
};
