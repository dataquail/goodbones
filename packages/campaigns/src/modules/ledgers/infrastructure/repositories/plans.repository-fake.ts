import * as Result from "effect/Result";

import type { PlanRecord } from "../../domain/plan/plan.root.js";
import type { PlansRepository } from "../../domain/ports/repositories/plans.repository.js";

export type PlansRepositoryFake = PlansRepository & {
  // What the repository holds now, by campaign.
  readonly stored: ReadonlyMap<string, PlanRecord>;
};

// In memory, one plan per campaign.
export const makePlansRepositoryFake = (
  seed: ReadonlyArray<PlanRecord> = [],
): PlansRepositoryFake => {
  const stored = new Map(seed.map((one) => [one.campaign, one] as const));

  return {
    stored,
    findOne: (campaign) => Result.succeed(stored.get(campaign) ?? null),
    save: (plan) => {
      stored.set(plan.campaign, plan);
    },
  };
};
