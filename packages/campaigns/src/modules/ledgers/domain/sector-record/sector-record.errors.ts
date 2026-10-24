import * as Schema from "effect/Schema";

// A sector record that is there and cannot be read as one.
export class SectorRecordUnreadable extends Schema.TaggedError<SectorRecordUnreadable>()(
  "SectorRecordUnreadable",
  {
    at: Schema.String,
    // `misplaced`: a record of another campaign, and `detail` names it.
    reason: Schema.Literals(["not-json", "undecodable", "misplaced"]),
    detail: Schema.String,
  },
) {}
