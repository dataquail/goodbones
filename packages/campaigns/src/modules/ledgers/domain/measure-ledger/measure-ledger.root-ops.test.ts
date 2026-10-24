import { describe, expect, it } from "vitest";

import { EMPTY_MEASURE_LEDGER, type MeasureLedger } from "./measure-ledger.root.js";
import {
  clearedMeasure,
  concededMeasure,
  measureLedgerArithmeticHolds,
  measureProgressOf,
  measureStandingOf,
  recordedOf,
} from "./measure-ledger.root-ops.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 15);

describe("a scalar objective's ledger", () => {
  const entered = (value: number, direction: "down" | "up" = "down"): MeasureLedger =>
    clearedMeasure(
      EMPTY_MEASURE_LEDGER("c", "o", direction, T0),
      "billing",
      value,
      0,
      T0,
      "inside",
    );

  it("enters a sector at its value, and holds it there", () => {
    const ledger = entered(14.2);
    expect(ledger.sectors.billing).toEqual({
      entered: new Date(T0).toISOString(),
      initial: 14.2,
      recorded: 14.2,
      improved: 0,
      closed: null,
      lastImproved: new Date(T0).toISOString(),
    });
    expect(measureStandingOf(ledger, "billing", 14.2, 0)).toBe("within");
    expect(measureStandingOf(ledger, "billing", 15, 0)).toBe("breached");
    expect(measureStandingOf(ledger, "billing", 13, 0)).toBe("surpassed");
    expect(measureStandingOf(ledger, "orders", 1, 0)).toBe("unrecorded");
  });

  it("gives a wobbling number its tolerance either way", () => {
    const ledger = entered(10);
    expect(measureStandingOf(ledger, "billing", 11.5, 2)).toBe("within");
    expect(measureStandingOf(ledger, "billing", 8.5, 2)).toBe("within");
    expect(measureStandingOf(ledger, "billing", 12.5, 2)).toBe("breached");
    // An improvement inside the tolerance is not recorded by clear.
    expect(clearedMeasure(ledger, "billing", 8.5, 2, T0 + DAY, "inside")).toBe(ledger);
  });

  it("records an improvement on clear, and a rise only on concede — the arithmetic holds throughout", () => {
    const start = entered(14.2);
    const improved = clearedMeasure(start, "billing", 9.8, 0, T0 + DAY, "inside");
    expect(improved.sectors.billing).toMatchObject({
      recorded: 9.8,
      improved: 4.4,
      lastImproved: new Date(T0 + DAY).toISOString(),
    });
    expect(measureLedgerArithmeticHolds(improved)).toBe(true);

    // A rise is not clear's to record.
    expect(clearedMeasure(improved, "billing", 11, 0, T0 + 2 * DAY, "inside")).toBe(improved);

    const conceded = concededMeasure(improved, "billing", 11, {
      at: T0 + 2 * DAY,
      by: "me",
      reason: "vendored a parser",
    });

    expect(conceded.sectors.billing?.recorded).toBe(11);
    expect(conceded.concessions).toEqual([
      {
        sector: "billing",
        at: new Date(T0 + 2 * DAY).toISOString(),
        by: "me",
        from: 9.8,
        to: 11,
        reason: "vendored a parser",
      },
    ]);
    expect(measureLedgerArithmeticHolds(conceded)).toBe(true);
    expect(recordedOf(conceded)).toBe(11);
  });

  it("fails the arithmetic on a record edited by hand", () => {
    const ledger = clearedMeasure(entered(14.2), "billing", 9.8, 0, T0 + DAY, "inside");

    const edited: MeasureLedger = {
      ...ledger,
      sectors: { billing: { ...(ledger.sectors.billing ?? fail()), recorded: 12 } },
    };

    expect(measureLedgerArithmeticHolds(edited)).toBe(false);
  });

  it("runs the arithmetic the other way for a number that should rise", () => {
    const up = entered(40, "up");
    const better = clearedMeasure(up, "billing", 55, 0, T0 + DAY, "inside");
    expect(better.sectors.billing).toMatchObject({ recorded: 55, improved: 15 });
    expect(measureStandingOf(better, "billing", 50, 0)).toBe("breached");
    const conceded = concededMeasure(better, "billing", 50, { at: T0, by: "me", reason: "why" });
    expect(measureLedgerArithmeticHolds(conceded)).toBe(true);
  });

  it("closes a sector at the value it left the window with, and never counts that as progress", () => {
    const ledger = entered(8);
    const closed = clearedMeasure(ledger, "billing", 7, 0, T0 + DAY, "outside");
    expect(closed.sectors.billing).toMatchObject({ recorded: 8, improved: 0, closed: 7 });
    expect(measureStandingOf(closed, "billing", 100, 0)).toBe("unrecorded");
    expect(recordedOf(closed)).toBe(0);
    // Born again: it enters again at its value, and the jump is a concession.
    const again = clearedMeasure(closed, "billing", 12, 0, T0 + 2 * DAY, "inside", "me");
    expect(again.sectors.billing).toMatchObject({ recorded: 12, closed: null });
    expect(again.concessions.at(-1)).toMatchObject({ from: 8, to: 12, by: "me" });
    expect(measureLedgerArithmeticHolds(again)).toBe(true);
  });

  it("reads progress toward the target, from where the sector entered", () => {
    const ledger = clearedMeasure(entered(100), "billing", 40, 0, T0 + DAY, "inside");
    expect(measureProgressOf(ledger, 0)).toBeCloseTo(0.6);
    expect(measureProgressOf(ledger, 40)).toBe(1);
  });
});

const fail = (): never => {
  throw new Error("missing");
};
