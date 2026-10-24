import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { PlanRecord } from "../../domain/plan/plan.root.js";

// The plan record as `<ledgerDir>/<campaign>/plan.json` keeps it.

const decodePlan = Schema.decodeUnknownResult(PlanRecord, {
  errors: "all",
  onExcessProperty: "error",
  reportInput: true,
});

export const decodePlanRecord = (raw: unknown): Result.Result<PlanRecord, string> => {
  const decoded = decodePlan(raw);

  return Result.isFailure(decoded)
    ? Result.fail(String(decoded.failure.issue))
    : Result.succeed(decoded.success);
};

export const serializePlanRecord = (record: PlanRecord): string =>
  `${JSON.stringify(record, null, 2)}\n`;

export const planPathOf = (dir: string, campaign: string): string => `${dir}/${campaign}/plan.json`;
