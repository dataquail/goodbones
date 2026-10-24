import type * as Result from "effect/Result";

import type { PlanUnreadable } from "../../plan/plan.errors.js";
import type { PlanRecord } from "../../plan/plan.root.js";

// What `clear` last saw of each campaign's phases, by campaign: `null`
// before the first `clear`.
export type PlansRepository = {
  readonly findOne: (campaign: string) => Result.Result<PlanRecord | null, PlanUnreadable>;
  readonly save: (plan: PlanRecord) => void;
};
