import * as Schema from "effect/Schema";

// The plan record: what `clear` last saw of the campaign's phases, so that
// `check` can tell a change to a defined phase (which needs a concession)
// from a refinement of an open one (which is free).
//
// A phase is recorded by what it asks, and the plan by the order its phases
// stand in. So inserting a phase changes no other, and moving two phases
// past each other changes the one that moved: the order is what a sector is
// asked first. Version 1 recorded a hash that covered the phase's index;
// such a record is compared exactly — the same digest, at the index it was
// recorded at — until the next `clear` rewrites it as version 2.

const PlanPhase = Schema.Struct({
  id: Schema.String,
  hash: Schema.String,
  defined: Schema.Boolean,
  concessions: Schema.Finite,
});

export const PlanRecord = Schema.Struct({
  version: Schema.Literals([1, 2]),
  campaign: Schema.String,
  phases: Schema.Array(PlanPhase),
});

export type PlanRecord = typeof PlanRecord.Type;
