import * as Schema from "effect/Schema";

// A plan record that is there and cannot be read as one.
export class PlanUnreadable extends Schema.TaggedError<PlanUnreadable>()("PlanUnreadable", {
  at: Schema.String,
  reason: Schema.Literals(["not-json", "undecodable"]),
  detail: Schema.String,
}) {}
