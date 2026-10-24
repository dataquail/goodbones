import * as Schema from "effect/Schema";

// A ledger that is there and cannot be read as one. It is refused, never
// read as empty: an empty ledger would report every hit as unrecorded growth
// and demand a concession for debt that was already counted.
export class LedgerUnreadable extends Schema.TaggedError<LedgerUnreadable>()("LedgerUnreadable", {
  at: Schema.String,
  // `not-json`: the text does not parse. `not-first-layout`: the file at a
  // campaign's first-layout path is in another layout. `undecodable`: it
  // parses and is not a ledger. `misplaced`: it is a ledger, of another
  // objective, and `detail` is the `<campaign>/<objective>` it names.
  reason: Schema.Literals(["not-json", "not-first-layout", "undecodable", "misplaced"]),
  detail: Schema.String,
  // Whether the file says it is a scalar objective's: a ledger of the
  // wrong kind is refused as that, before anything else it gets wrong.
  measure: Schema.Boolean,
}) {}
