import * as Schema from "effect/Schema";

// An objective's ledger: every place the pattern still occurs, per sector,
// and the record of every time a count was allowed to go up. It is the
// baseline's cousin and not the baseline — same fingerprint, different
// file, different semantics.
//
//   - One file per objective, `<ledger>/<campaign>/<objective>.json`, with
//     every counter and the holdout list per sector inside, so two pull
//     requests paying down the same objective in two sectors edit different
//     regions of the file and merge cleanly.
//   - Growth is only ever recorded, never silent. `clear` reconciles the
//     ledger with the code wherever that is not a regression; `concede` is
//     the one way a holdout is added by hand, and it always appends a
//     concession with a reason, a timestamp and an author.
//   - The arithmetic is checked, per sector:
//     `holdouts.length === initial + Σ delta − cleared − closed`. A
//     hand-added holdout with no concession fails the build, with no git
//     history in the loop.
//   - A holdout that no longer fires is stale, and `check` fails on it as it
//     fails on a stale baseline entry, so progress lands as a visible diff.
//   - A sector leaving an objective's window has its holdouts `closed` —
//     not cleared, so a window shutting is never counted as progress.

export const SectorLedger = Schema.Struct({
  // When the sector entered the objective's window.
  entered: Schema.String,
  // The count the day it did.
  initial: Schema.Finite,
  // Holdouts removed by `clear` since, because they stopped firing.
  cleared: Schema.Finite,
  // Holdouts still firing when the sector left the window.
  closed: Schema.Finite,
  // When a holdout last left the ledger — what the stall clock reads.
  lastCleared: Schema.String,
  // `file` or `file#subject`, relative to the sector's root; `~` for the
  // sector itself. Deduplicated and sorted.
  holdouts: Schema.Array(Schema.String),
});

// Growth conceded with a reason, or a re-baseline authorized by a phase
// concession: the holdouts as of the plan change, `from` the count before
// and `to` the count after.
const Growth = Schema.Struct({
  sector: Schema.String,
  at: Schema.String,
  by: Schema.String,
  delta: Schema.Finite,
  reason: Schema.String,
  holdouts: Schema.Array(Schema.String),
});

const Rebaseline = Schema.Struct({
  sector: Schema.String,
  at: Schema.String,
  by: Schema.String,
  from: Schema.Finite,
  to: Schema.Finite,
  reason: Schema.String,
});

export const Concession = Schema.Union([Growth, Rebaseline]);

export const Ledger = Schema.Struct({
  version: Schema.Literal(2),
  campaign: Schema.String,
  objective: Schema.String,
  created: Schema.String,
  sectors: Schema.Record(Schema.String, SectorLedger),
  concessions: Schema.Array(Concession),
});

export type Ledger = typeof Ledger.Type;

export type SectorLedger = typeof SectorLedger.Type;

export type Concession = typeof Concession.Type;

export const EMPTY_LEDGER = (campaign: string, objective: string, now: number): Ledger => ({
  version: 2,
  campaign,
  objective,
  created: new Date(now).toISOString(),
  sectors: {},
  concessions: [],
});
