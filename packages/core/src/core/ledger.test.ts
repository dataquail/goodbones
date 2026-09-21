import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { CampaignRule } from "../domain/architecture-config.js";
import { compileCampaignRule, type CompiledCampaign } from "./campaigns.js";
import {
  clearedSector,
  concededSector,
  decodeLedger,
  decodeSectorRecord,
  EMPTY_LEDGER,
  EMPTY_SECTOR_RECORD,
  holdoutsOf,
  isComplete,
  isStalled,
  type Ledger,
  ledgerArithmeticHolds,
  notedRecord,
  planDiffOf,
  planOf,
  positionOf,
  progressOf,
  reachedRecord,
  rebaselinedSector,
  reconcileSector,
  sectorArithmeticHolds,
  serializeLedger,
  serializeSectorRecord,
} from "./ledger.js";
import { IMPLICIT_SECTOR } from "./sectors.js";

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

    const tampered: Ledger = {
      ...afterConcede,
      sectors: {
        billing: {
          ...afterConcede.sectors.billing!,
          holdouts: [...afterConcede.sectors.billing!.holdouts, "f.ts"],
        },
      },
    };
    expect(sectorArithmeticHolds(tampered, "billing")).toBe(false);
    expect(ledgerArithmeticHolds(tampered)).toBe(false);
  });

  it("keeps two sectors apart in one file", () => {
    const both = clearedSector(ledgerOf(["a.ts"]), "orders", ["x.ts", "y.ts"], "file", T0, "inside");
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
      clearedSector(ledger, "billing", ["a.ts", "b.ts"], "file", T0 + DAY, "inside").sectors
        .billing?.lastCleared,
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
    expect(rebaselinedSector(ledger, "billing", ["a.ts", "b.ts"], { at: T0, by: "me", reason: "r" })).toBe(
      ledger,
    );
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

describe("the file", () => {
  it("round-trips through serialize and decode, and refuses a malformed one", () => {
    const ledger = ledgerOf(["a.ts#Foo"]);
    const decoded = decodeLedger(JSON.parse(serializeLedger(ledger)));
    expect(Result.isSuccess(decoded) && decoded.success).toEqual(ledger);
    expect(Result.isFailure(decodeLedger({ version: 2, sectors: {} }))).toBe(true);
    expect(Result.isFailure(decodeLedger({ ...ledger, extra: 1 }))).toBe(true);
  });

  it("reads the family's first layout as one sector, the implicit one", () => {
    const decoded = decodeLedger({
      version: 1,
      id: "x",
      created: "2026-09-15T00:00:00.000Z",
      initial: 3,
      fixed: 1,
      lastProgress: "2026-09-16T00:00:00.000Z",
      regressions: [
        { at: "2026-09-17T00:00:00.000Z", by: "me", delta: 1, reason: "r", entries: ["c.ts"] },
      ],
      entries: ["a.ts", "b.ts", "c.ts"],
    });
    expect(Result.isSuccess(decoded) && decoded.success).toEqual({
      version: 2,
      campaign: "x",
      objective: "x",
      created: "2026-09-15T00:00:00.000Z",
      sectors: {
        [IMPLICIT_SECTOR]: {
          entered: "2026-09-15T00:00:00.000Z",
          initial: 3,
          cleared: 1,
          closed: 0,
          lastCleared: "2026-09-16T00:00:00.000Z",
          holdouts: ["a.ts", "b.ts", "c.ts"],
        },
      },
      concessions: [
        {
          sector: IMPLICIT_SECTOR,
          at: "2026-09-17T00:00:00.000Z",
          by: "me",
          delta: 1,
          reason: "r",
          holdouts: ["c.ts"],
        },
      ],
    });
    expect(Result.isSuccess(decoded) && ledgerArithmeticHolds(decoded.success)).toBe(true);
  });
});

const campaign = (phases: CampaignRule["phases"], objectives: ReadonlyArray<string>): CompiledCampaign => {
  const compiled = compileCampaignRule({
    name: "campaign/c",
    id: "c",
    scope: "^src/",
    extensions: [],
    phases,
    objectives: objectives.map((id) => ({
      name: `campaign/c/${id}`,
      id,
      campaign: "c",
      message: "m",
      holdout: "file",
      match: { path: { file: "." } },
      probes: { fires: [], ignores: [] },
    })),
    onComplete: "keep",
  });
  if (Result.isFailure(compiled)) throw compiled.failure;
  return compiled.success;
};

const phase = (id: string, objectives: ReadonlyArray<string>, hash = id) => ({
  id,
  objectives,
  attested: false,
  concessions: [],
  hash,
});

describe("the sector record", () => {
  it("only advances reached, and reads it back as an index", () => {
    const rule = campaign([phase("a", ["x"]), phase("b", ["y"]), phase("c", [])], ["x", "y"]);
    const fresh = EMPTY_SECTOR_RECORD("c", "billing", T0);
    expect(positionOf(rule, fresh).reached).toBe(-1);
    expect(positionOf(rule, undefined).reached).toBe(-1);
    const atB = reachedRecord(fresh, rule, 1, T0 + DAY);
    expect(atB.reached).toBe("b");
    expect(atB.since).toBe(new Date(T0 + DAY).toISOString());
    expect(positionOf(rule, atB).reached).toBe(1);
    expect(reachedRecord(atB, rule, 0, T0 + 2 * DAY)).toBe(atB);
    expect(reachedRecord(atB, rule, 1, T0 + 2 * DAY)).toBe(atB);
    expect(reachedRecord(atB, rule, 3, T0 + 2 * DAY)).toBe(atB);
  });

  it("caps notes, round-trips, and refuses a malformed one", () => {
    let record = EMPTY_SECTOR_RECORD("c", "billing", T0);
    for (let i = 0; i < 25; i += 1) {
      record = notedRecord(record, { at: T0 + i, by: "me", phase: "a", text: `note ${String(i)}` });
    }
    expect(record.notes.length).toBe(20);
    expect(record.notes[0]?.text).toBe("note 5");
    const long = notedRecord(record, { at: T0, by: "me", phase: null, text: "x".repeat(600) });
    expect(long.notes.at(-1)?.text.length).toBe(500);
    const decoded = decodeSectorRecord(JSON.parse(serializeSectorRecord(record)));
    expect(Result.isSuccess(decoded) && decoded.success).toEqual(record);
    expect(Result.isFailure(decodeSectorRecord({ version: 1 }))).toBe(true);
  });
});

describe("the plan record", () => {
  it("tells a refinement from a change, and a change from a receipted one", () => {
    const before = planOf(campaign([phase("a", ["x"]), phase("b", [])], ["x"]));
    // The open phase gained criteria: refined, free.
    const refined = campaign([phase("a", ["x"]), phase("b", ["y"], "b2")], ["x", "y"]);
    expect(planDiffOf(refined, before)).toEqual({ refined: ["b"], changed: [], unreceipted: [] });
    // The defined phase changed with no concession: unreceipted.
    const changed = campaign([phase("a", ["x"], "a2"), phase("b", [])], ["x"]);
    expect(planDiffOf(changed, before)).toEqual({ refined: [], changed: ["a"], unreceipted: ["a"] });
    // With one: changed, and receipted.
    const receipted = campaign(
      [{ ...phase("a", ["x"], "a2"), concessions: [{ reason: "r", at: "2026-09-20" }] }, phase("b", [])],
      ["x"],
    );
    expect(planDiffOf(receipted, before)).toEqual({ refined: [], changed: ["a"], unreceipted: [] });
    // A new phase is a refinement; a removed defined one is a change.
    const grown = campaign([phase("a", ["x"]), phase("b", []), phase("c", [])], ["x"]);
    expect(planDiffOf(grown, before).refined).toEqual(["c"]);
    const shrunk = campaign([phase("b", [])], []);
    expect(planDiffOf(shrunk, before)).toEqual({ refined: [], changed: ["a"], unreceipted: ["a"] });
    // Nothing recorded yet: nothing to compare.
    expect(planDiffOf(changed, undefined)).toEqual({ refined: [], changed: [], unreceipted: [] });
  });
});
