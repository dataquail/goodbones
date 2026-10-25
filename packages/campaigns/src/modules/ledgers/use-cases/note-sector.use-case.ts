import type { LoadedPolicy } from "@goodbones/core";
import * as Result from "effect/Result";

import type { CampaignEvaluation } from "../../../core/campaign-state.js";
import { campaignsOf } from "../../../load/campaign-policy.js";
import { EMPTY_SECTOR_RECORD } from "../domain/sector-record/sector-record.root.js";
import { notedRecord } from "../domain/sector-record/sector-record.root-ops.js";
import { phaseIdOf, recordOf } from "../domain/services/campaign-ledgers.service.js";
import { sectorRecordPathOf } from "../infrastructure/repositories/sector-record.mapper.js";

// `campaigns note`: a dated remark for the next person or agent to touch the
// sector, recorded under the phase it was left at. Answers where the record
// was saved.
export const noteSectorUseCase = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  sector: string,
  text: string,
  by: string,
): Result.Result<string, string> => {
  const { rule } = evaluation;
  const campaigns = campaignsOf(policy);
  const state = evaluation.sectors.get(sector);

  if (state === undefined)
    return Result.fail(`campaign ${rule.id} has no sector named "${sector}"`);

  const before =
    recordOf(campaigns, rule, sector) ?? EMPTY_SECTOR_RECORD(rule.id, sector, policy.now);

  const after = notedRecord(before, {
    phase: phaseIdOf(rule, state.phase),
    text,
    by,
    at: policy.now,
  });

  if (Result.isFailure(after)) return Result.fail(after.failure);
  campaigns.repositories.sectorRecords.save(after.success);

  return Result.succeed(sectorRecordPathOf(campaigns.ledgerDir, rule.id, sector));
};
