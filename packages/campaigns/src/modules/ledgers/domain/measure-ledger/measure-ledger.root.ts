import * as Schema from "effect/Schema";

import type { MeasureDirection } from "../../../../domain/config.js";

// A scalar objective's ledger: a number per sector, the best value `clear`
// has recorded for it, and every rise conceded. The same file, a second
// schema — told apart by `kind`, which the holdout ledger does not carry, so
// every ledger written before scalars existed decodes as it did.
//
//   - `check` holds each sector in window to `recorded`, within the
//     objective's tolerance: a value worse by more is unrecorded growth,
//     and a value better by more is progress `clear` has not written yet —
//     stale, as a holdout that stopped firing is.
//   - `clear` writes an improvement: `recorded` moves to the value and the
//     difference joins `improved`. `concede` writes a rise, with a reason.
//   - The arithmetic, per sector, in the direction that is worse:
//     `recorded = initial + Σ rise − improved`.
//   - A sector leaving the window is `closed` at the value it left with;
//     nothing after that counts.

const MeasureSectorLedger = Schema.Struct({
  entered: Schema.String,
  // The value the day the sector entered the window.
  initial: Schema.Finite,
  // The value the sector is held to.
  recorded: Schema.Finite,
  // Every improvement `clear` recorded, summed, as a magnitude.
  improved: Schema.Finite,
  // The value the sector left the window with, or `null` while inside it.
  closed: Schema.NullOr(Schema.Finite),
  // When `recorded` last improved — what the stall clock reads.
  lastImproved: Schema.String,
});

// A rise conceded with a reason, or a re-baseline a phase concession
// authorized: the recorded value before and after.
const MeasureConcession = Schema.Struct({
  sector: Schema.String,
  at: Schema.String,
  by: Schema.String,
  from: Schema.Finite,
  to: Schema.Finite,
  reason: Schema.String,
});

export const MeasureLedger = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("measure"),
  campaign: Schema.String,
  objective: Schema.String,
  created: Schema.String,
  direction: Schema.Literals(["down", "up"]),
  sectors: Schema.Record(Schema.String, MeasureSectorLedger),
  concessions: Schema.Array(MeasureConcession),
});

export type MeasureLedger = typeof MeasureLedger.Type;

export type MeasureSectorLedger = typeof MeasureSectorLedger.Type;

export type MeasureConcession = typeof MeasureConcession.Type;

export const EMPTY_MEASURE_LEDGER = (
  campaign: string,
  objective: string,
  direction: MeasureDirection,
  now: number,
): MeasureLedger => ({
  version: 2,
  kind: "measure",
  campaign,
  objective,
  created: new Date(now).toISOString(),
  direction,
  sectors: {},
  concessions: [],
});
