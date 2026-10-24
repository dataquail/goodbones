import { type Standing, standingOf } from "@goodbones/core";

import { roundMeasure } from "../../../../core/campaigns.js";
import type { MeasureDirection } from "../../../../domain/config.js";
import type { MeasureLedger } from "./measure-ledger.root.js";

// What may happen to a scalar objective's ledger, and what it says: held
// to its record by `check`, improved by `clear`, risen only by `concede`.

// Who conceded, when and why: the holdout ledger's record, restated here
// because one aggregate does not reach into another.
export type ConcessionRecord = {
  readonly at: number;
  readonly by: string;
  readonly reason: string;
};

// How much worse `to` is than `from`, in the ledger's direction.
const worseBy = (direction: MeasureDirection, from: number, to: number): number =>
  direction === "down" ? to - from : from - to;

// Sums of rounded numbers carry float error; the arithmetic is exact to
// well under the six decimals a value is measured to.
const EPSILON = 1e-6;

export const measureArithmeticHolds = (ledger: MeasureLedger, sector: string): boolean => {
  const risen = ledger.concessions
    .filter((one) => one.sector === sector)
    .reduce((sum, one) => sum + worseBy(ledger.direction, one.from, one.to), 0);

  const own = ledger.sectors[sector];

  if (own === undefined) return Math.abs(risen) < EPSILON;
  const expected = worseBy(ledger.direction, own.initial, own.recorded);

  return Math.abs(expected - (risen - own.improved)) < EPSILON;
};

export const measureLedgerArithmeticHolds = (ledger: MeasureLedger): boolean =>
  [
    ...new Set([...Object.keys(ledger.sectors), ...ledger.concessions.map((one) => one.sector)]),
  ].every((sector) => measureArithmeticHolds(ledger, sector));

// Where a sector's value stands against what its ledger holds it to.
export const measureStandingOf = (
  ledger: MeasureLedger,
  sector: string,
  value: number,
  tolerance: number,
): Standing | "unrecorded" => {
  const own = ledger.sectors[sector];

  if (own === undefined || own.closed !== null) return "unrecorded";

  return standingOf({ direction: ledger.direction, limit: own.recorded, tolerance }, value);
};

// `clear` for one sector, in one of three positions: entering the window
// (recorded at its value), inside it (an improvement past the tolerance
// becomes the record), or past it (closed at the value it left with).
export const clearedMeasure = (
  ledger: MeasureLedger,
  sector: string,
  value: number,
  tolerance: number,
  now: number,
  window: "inside" | "outside",
  by = "objectives clear",
): MeasureLedger => {
  const at = new Date(now).toISOString();
  const own = ledger.sectors[sector];

  if (window === "outside") {
    if (own === undefined || own.closed !== null) return ledger;

    return {
      ...ledger,
      sectors: {
        ...ledger.sectors,
        [sector]: { ...own, closed: Number.isNaN(value) ? own.recorded : value },
      },
    };
  }

  if (Number.isNaN(value)) return ledger;

  if (own === undefined) {
    return {
      ...ledger,
      sectors: {
        ...ledger.sectors,
        [sector]: {
          entered: at,
          initial: value,
          recorded: value,
          improved: 0,
          closed: null,
          lastImproved: at,
        },
      },
    };
  }

  if (own.closed !== null) {
    // A sector born again after it was closed — its marker restored, say —
    // enters again at its value, and the move from its old record is a
    // concession, so the arithmetic still holds and the jump is in the file.
    return {
      ...ledger,
      sectors: { ...ledger.sectors, [sector]: { ...own, recorded: value, closed: null } },
      concessions:
        own.recorded === value
          ? ledger.concessions
          : [
              ...ledger.concessions,
              { sector, at, by, from: own.recorded, to: value, reason: "entered the window again" },
            ],
    };
  }

  if (
    standingOf({ direction: ledger.direction, limit: own.recorded, tolerance }, value) !==
    "surpassed"
  ) {
    return ledger;
  }

  return {
    ...ledger,
    sectors: {
      ...ledger.sectors,
      [sector]: {
        ...own,
        recorded: value,
        improved: roundMeasure(own.improved - worseBy(ledger.direction, own.recorded, value)),
        lastImproved: at,
      },
    },
  };
};

// `concede`, or a re-baseline: the sector is held to its value from now,
// and a concession records the move with its reason. A sector the ledger
// has not recorded is `clear`'s to enter, not a concession's.
export const concededMeasure = (
  ledger: MeasureLedger,
  sector: string,
  value: number,
  record: ConcessionRecord,
): MeasureLedger => {
  const own = ledger.sectors[sector];

  if (own === undefined || own.closed !== null || Number.isNaN(value)) return ledger;

  if (own.recorded === value) return ledger;

  return {
    ...ledger,
    sectors: { ...ledger.sectors, [sector]: { ...own, recorded: value } },
    concessions: [
      ...ledger.concessions,
      {
        sector,
        at: new Date(record.at).toISOString(),
        by: record.by,
        from: own.recorded,
        to: value,
        reason: record.reason,
      },
    ],
  };
};

// What the ledger holds the open sectors to, summed.
export const recordedOf = (ledger: MeasureLedger): number =>
  roundMeasure(
    Object.values(ledger.sectors)
      .filter((one) => one.closed === null)
      .reduce((sum, one) => sum + one.recorded, 0),
  );

export const lastImprovedOf = (ledger: MeasureLedger): string | null => {
  const stamps = Object.values(ledger.sectors).map((one) => one.lastImproved);

  return stamps.length === 0 ? null : stamps.reduce((a, b) => (a > b ? a : b));
};

// How far the open sectors have come from where they entered toward the
// target: `1` at it, `0` where they started. A standing measure has no
// target to come toward, and reads as its improvement over its initial.
export const measureProgressOf = (ledger: MeasureLedger, target: number | null): number => {
  const open = Object.values(ledger.sectors).filter((one) => one.closed === null);

  if (open.length === 0) return 1;
  const initial = open.reduce((sum, one) => sum + one.initial, 0);
  const recorded = open.reduce((sum, one) => sum + one.recorded, 0);
  const goal = target === null ? 0 : target * open.length;
  const span = worseBy(ledger.direction, goal, initial);

  if (span <= 0) return 1;

  return Math.min(1, Math.max(0, 1 - worseBy(ledger.direction, goal, recorded) / span));
};

// One sector's share of the way from where it entered to the target. `0`
// for a sector the ledger has not recorded, or a standing measure.
export const measureSectorProgressOf = (
  ledger: MeasureLedger | undefined,
  sector: string,
  target: number | null,
): number => {
  const own = ledger?.sectors[sector];

  if (ledger === undefined || own === undefined || target === null) return 0;
  const span = worseBy(ledger.direction, target, own.initial);

  if (span <= 0) return 1;

  return Math.min(1, Math.max(0, 1 - worseBy(ledger.direction, target, own.recorded) / span));
};

export const MeasureLedgerRootOps = {
  measureArithmeticHolds,
  measureLedgerArithmeticHolds,
  measureStandingOf,
  clearedMeasure,
  concededMeasure,
  recordedOf,
  lastImprovedOf,
  measureProgressOf,
  measureSectorProgressOf,
} as const;
