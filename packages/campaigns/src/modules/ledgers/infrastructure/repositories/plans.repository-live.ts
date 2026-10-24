import * as Result from "effect/Result";

import { PlanUnreadable } from "../../domain/plan/plan.errors.js";
import type { PlansRepository } from "../../domain/ports/repositories/plans.repository.js";
import { parseJson } from "./ledger.mapper.js";
import { type LedgerStore, writeStoredFile } from "./objective-ledgers.repository-live.js";
import { decodePlanRecord, planPathOf, serializePlanRecord } from "./plan.mapper.js";

export const makePlansRepositoryLive = ({
  fileSystem,
  ledgerDir,
  repoRoot,
}: LedgerStore): PlansRepository => ({
  findOne: (campaign) => {
    const at = planPathOf(ledgerDir, campaign);
    const text = fileSystem.readText(at);

    if (text === null) return Result.succeed(null);
    const raw = parseJson(text);

    if (Result.isFailure(raw)) {
      return Result.fail(new PlanUnreadable({ at, reason: "not-json", detail: raw.failure }));
    }

    const decoded = decodePlanRecord(raw.success);

    return Result.isFailure(decoded)
      ? Result.fail(new PlanUnreadable({ at, reason: "undecodable", detail: decoded.failure }))
      : Result.succeed(decoded.success);
  },
  save: (plan) => {
    writeStoredFile(repoRoot, planPathOf(ledgerDir, plan.campaign), serializePlanRecord(plan));
  },
});
