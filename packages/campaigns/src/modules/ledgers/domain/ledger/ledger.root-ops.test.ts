import { describe, expect, it } from "vitest";

import { EMPTY_LEDGER, type Ledger } from "./ledger.root.js";
import {
  clearedSector,
  concededSector,
  holdoutsOf,
  isComplete,
  isStalled,
  ledgerArithmeticHolds,
  progressOf,
  rebaselinedSector,
  reconcileEntries,
  reconcileSector,
  sectorArithmeticHolds,
} from "./ledger.root-ops.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 15);

// A first ledger: the sector enters the window with every entry, as `clear`
// writes it.
const ledgerOf = (entries: ReadonlyArray<string>, sector = "billing"): Ledger =>
  clearedSector(EMPTY_LEDGER("c", "o", T0), sector, entries, "file", T0, "inside");

describe("the arithmetic, per sector", () => {
  it("holds after clear and concede, and fails on a hand-added holdout", () => {
    const initial = ledgerOf(["a.ts", "b.ts", "c.ts"]);
    expect(initial.sectors.billing).toMatchObject({ initial: 3, cleared: 0, closed: 0 });
    expect(ledgerArithmeticHolds(initial)).toBe(true);

    const afterClear = clearedSector(initial, "billing", ["a.ts"], "file", T0 + DAY, "inside");
    expect(afterClear.sectors.billing?.holdouts).toEqual(["a.ts"]);
    expect(afterClear.sectors.billing?.cleared).toBe(2);
    expect(ledgerArithmeticHolds(afterClear)).toBe(true);

    const afterConcede = concededSector(afterClear, "billing", ["d.ts", "e.ts"], {
      at: T0 + 2 * DAY,
      by: "me",
      reason: "vendor",
    });

    expect(afterConcede.sectors.billing?.holdouts).toEqual(["a.ts", "d.ts", "e.ts"]);
    expect(afterConcede.concessions).toEqual([
      {
        sector: "billing",
        at: new Date(T0 + 2 * DAY).toISOString(),
        by: "me",
        delta: 2,
        reason: "vendor",
        holdouts: ["d.ts", "e.ts"],
      },
    ]);
    expect(ledgerArithmeticHolds(afterConcede)).toBe(true);

    const billing = afterConcede.sectors.billing;

    if (billing === undefined) throw new Error("no billing sector");

    const tampered: Ledger = {
      ...afterConcede,
      sectors: { billing: { ...billing, holdouts: [...billing.holdouts, "f.ts"] } },
    };

    expect(sectorArithmeticHolds(tampered, "billing")).toBe(false);
    expect(ledgerArithmeticHolds(tampered)).toBe(false);
  });

  it("keeps two sectors apart in one file", () => {
    const both = clearedSector(
      ledgerOf(["a.ts"]),
      "orders",
      ["x.ts", "y.ts"],
      "file",
      T0,
      "inside",
    );

    expect(Object.keys(both.sectors)).toEqual(["billing", "orders"]);
    const cleared = clearedSector(both, "orders", ["x.ts"], "file", T0 + DAY, "inside");
    expect(cleared.sectors.billing).toEqual(both.sectors.billing);
    expect(cleared.sectors.orders?.cleared).toBe(1);
    expect(holdoutsOf(cleared)).toBe(2);
  });

  it("conceding a holdout already present is not growth", () => {
    const ledger = ledgerOf(["a.ts"]);
    expect(concededSector(ledger, "billing", ["a.ts"], { at: T0, by: "me", reason: "r" })).toBe(
      ledger,
    );
  });
});

describe("clear", () => {
  it("stamps lastCleared only when something left", () => {
    const ledger = ledgerOf(["a.ts", "b.ts"]);
    expect(
      clearedSector(ledger, "billing", ["a.ts", "b.ts"], "file", T0 + DAY, "inside").sectors.billing
        ?.lastCleared,
    ).toBe(ledger.sectors.billing?.lastCleared);
    expect(
      clearedSector(ledger, "billing", ["a.ts"], "file", T0 + DAY, "inside").sectors.billing
        ?.lastCleared,
    ).toBe(new Date(T0 + DAY).toISOString());
  });

  it("closes what still fires when the sector leaves the window, and that is not progress", () => {
    const ledger = ledgerOf(["a.ts", "b.ts"]);
    const closed = clearedSector(ledger, "billing", ["a.ts"], "file", T0 + DAY, "outside");
    expect(closed.sectors.billing).toMatchObject({
      holdouts: [],
      closed: 2,
      cleared: 0,
      lastCleared: ledger.sectors.billing?.lastCleared,
    });
    expect(ledgerArithmeticHolds(closed)).toBe(true);
    expect(clearedSector(EMPTY_LEDGER("c", "o", T0), "billing", [], "file", T0, "outside")).toEqual(
      EMPTY_LEDGER("c", "o", T0),
    );
  });

  it("rewrites a match entry whose hash drifted under a still-present anchor, counting it as neither", () => {
    const ledger = clearedSector(
      EMPTY_LEDGER("c", "o", T0),
      "billing",
      ["a.ts#Foo#11111111", "a.ts#Foo#22222222"],
      "match",
      T0,
      "inside",
    );

    const now = ["a.ts#Foo#11111111", "a.ts#Foo#33333333"];
    const state = reconcileSector(ledger, "billing", now, "match");
    expect(state.stale).toEqual([]);
    expect(state.unrecorded).toEqual([]);
    expect(state.drifted).toEqual([{ from: "a.ts#Foo#22222222", to: "a.ts#Foo#33333333" }]);
    const after = clearedSector(ledger, "billing", now, "match", T0 + DAY, "inside");
    expect(after.sectors.billing?.holdouts).toEqual(["a.ts#Foo#11111111", "a.ts#Foo#33333333"]);
    expect(after.sectors.billing?.cleared).toBe(0);
    expect(after.sectors.billing?.lastCleared).toBe(ledger.sectors.billing?.lastCleared);
    // A second match under the anchor beyond what the ledger carries is growth.
    expect(
      reconcileSector(ledger, "billing", [...now, "a.ts#Foo#44444444"], "match").unrecorded,
    ).toEqual(["a.ts#Foo#44444444"]);
    // A declaration objective pairs nothing: a renamed declaration is fixed and new.
    expect(
      reconcileSector(ledgerOf(["a.ts#Foo"]), "billing", ["a.ts#Bar"], "declaration").stale,
    ).toEqual(["a.ts#Foo"]);
    // A sector the ledger has not seen carries nothing.
    expect(reconcileSector(ledger, "orders", ["z.ts#Foo#1"], "match").unrecorded).toEqual([
      "z.ts#Foo#1",
    ]);
  });

  it("pairs a match whose declaration was renamed by its file and text, not as fixed and new", () => {
    const ledger = clearedSector(
      EMPTY_LEDGER("c", "o", T0),
      "billing",
      ["a.ts#applied#11111111", "a.ts#applied#11111111~2", "b.ts#applied#22222222"],
      "match",
      T0,
      "inside",
    );

    const now = ["a.ts#outcome#11111111", "a.ts#outcome#11111111~2", "b.ts#other#33333333"];
    const state = reconcileSector(ledger, "billing", now, "match");
    expect(state.drifted).toEqual([
      { from: "a.ts#applied#11111111", to: "a.ts#outcome#11111111" },
      { from: "a.ts#applied#11111111~2", to: "a.ts#outcome#11111111~2" },
    ]);
    // Another name and other text in the same file is a fix and a new holdout.
    expect(state.stale).toEqual(["b.ts#applied#22222222"]);
    expect(state.unrecorded).toEqual(["b.ts#other#33333333"]);
    // The same text in another file is not the same holdout.
    expect(reconcileEntries(["a.ts#f#11111111"], ["c.ts#f#11111111"], "match")).toMatchObject({
      stale: ["a.ts#f#11111111"],
      unrecorded: ["c.ts#f#11111111"],
    });
    const after = clearedSector(ledger, "billing", now, "match", T0 + DAY, "inside");
    expect(after.sectors.billing).toMatchObject({ cleared: 1 });
    expect(after.sectors.billing?.holdouts).toContain("a.ts#outcome#11111111~2");
  });

  it("re-baselines a sector under a phase concession, recording from and to", () => {
    const ledger = ledgerOf(["a.ts", "b.ts"]);

    const after = rebaselinedSector(ledger, "billing", ["a.ts", "c.ts", "d.ts"], {
      at: T0 + DAY,
      by: "me",
      reason: "phase widened",
    });

    expect(after.sectors.billing?.holdouts).toEqual(["a.ts", "c.ts", "d.ts"]);
    expect(after.concessions).toEqual([
      {
        sector: "billing",
        at: new Date(T0 + DAY).toISOString(),
        by: "me",
        from: 2,
        to: 3,
        reason: "phase widened",
      },
    ]);
    expect(ledgerArithmeticHolds(after)).toBe(true);
    expect(
      rebaselinedSector(ledger, "billing", ["a.ts", "b.ts"], { at: T0, by: "me", reason: "r" }),
    ).toBe(ledger);
  });
});

describe("progress, stalls and completion against a fixed clock", () => {
  it("measures progress against everything ever conceded, closed holdouts aside", () => {
    const ledger = concededSector(
      clearedSector(
        ledgerOf(["a.ts", "b.ts", "c.ts", "d.ts"]),
        "billing",
        ["a.ts", "b.ts"],
        "file",
        T0,
        "inside",
      ),
      "billing",
      ["e.ts"],
      { at: T0, by: "me", reason: "r" },
    );

    // 3 left of 5 ever ledgered.
    expect(progressOf(ledger)).toBeCloseTo(0.4);
    expect(progressOf(EMPTY_LEDGER("c", "o", T0))).toBe(1);
    // Closing two of the three leaves 1 of 3: the closed ones were never
    // paid down and are not counted as such.
    const shut = clearedSector(ledger, "billing", [], "file", T0, "outside");
    expect(progressOf(shut)).toBeCloseTo(2 / 2);
  });

  it("is stalled after staleAfter without progress, unless complete, and never without a staleAfter", () => {
    const rule = { staleAfter: 30 * DAY };
    const ledger = ledgerOf(["a.ts"]);
    expect(isStalled(rule, ledger, T0 + 29 * DAY)).toBe(false);
    expect(isStalled(rule, ledger, T0 + 31 * DAY)).toBe(true);
    // A note left or a phase reached moves the sector's own clock.
    expect(isStalled(rule, ledger, T0 + 31 * DAY, new Date(T0 + 20 * DAY).toISOString())).toBe(
      false,
    );
    expect(isStalled({ staleAfter: null }, ledger, T0 + 365 * DAY)).toBe(false);
    const done = clearedSector(ledger, "billing", [], "file", T0, "inside");
    expect(isComplete(done)).toBe(true);
    expect(isStalled(rule, done, T0 + 365 * DAY)).toBe(false);
  });
});
