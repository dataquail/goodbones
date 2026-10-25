import type { LoadedPolicy } from "@goodbones/core";
import * as Result from "effect/Result";

import type { CampaignEvaluation } from "../../../core/campaign-state.js";
import { campaignsOf } from "../../../load/campaign-policy.js";
import { EMPTY_SECTOR_RECORD } from "../domain/sector-record/sector-record.root.js";
import { attestedRecord } from "../domain/sector-record/sector-record.root-ops.js";
import { phaseIdOf, recordOf } from "../domain/services/campaign-ledgers.service.js";
import { sectorRecordPathOf } from "../infrastructure/repositories/sector-record.mapper.js";

// `campaigns attest`: a step no detector sees is recorded done for a sector —
// with a reason and evidence — and only while the sector stands at that
// phase, so it cannot be recorded ahead and passed through on arrival.
// Answers where the record was saved.
export const attestSectorUseCase = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  sector: string,
  phaseId: string,
  entry: { reason: string; evidence: string | undefined; by: string },
): Result.Result<string, string> => {
  const { rule } = evaluation;
  const campaigns = campaignsOf(policy);
  const state = evaluation.sectors.get(sector);

  if (state === undefined)
    return Result.fail(`campaign ${rule.id} has no sector named "${sector}"`);
  const phase = rule.phases.find((one) => one.id === phaseId);

  if (phase === undefined) return Result.fail(`campaign ${rule.id} has no phase "${phaseId}"`);

  if (!phase.attested)
    return Result.fail(
      `phase ${phaseId} is not an attested phase; its objectives decide when a sector leaves it.`,
    );
  const current = phaseIdOf(rule, state.phase);

  if (current !== phaseId) {
    return Result.fail(
      `sector ${sector} stands at ${current ?? "the end"}, not ${phaseId}. An attestation is accepted only while the sector is at that phase.`,
    );
  }

  const before =
    recordOf(campaigns, rule, sector) ?? EMPTY_SECTOR_RECORD(rule.id, sector, policy.now);

  const after = attestedRecord(before, {
    phase: phaseId,
    reason: entry.reason,
    ...(entry.evidence === undefined ? {} : { evidence: entry.evidence }),
    at: policy.now,
    by: entry.by,
  });

  campaigns.repositories.sectorRecords.save(after);

  return Result.succeed(sectorRecordPathOf(campaigns.ledgerDir, rule.id, sector));
};
