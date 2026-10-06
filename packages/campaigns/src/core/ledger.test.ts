import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { CampaignRule } from "../domain/config.js";
import { digest } from "../domain/digest.js";
import { compileCampaignRule, type CompiledCampaign } from "./campaigns.js";
import {
  attestedRecord,
  clearedMeasure,
  clearedSector,
  concededMeasure,
  concededSector,
  decodeLedger,
  decodeMeasureLedger,
  decodePlanRecord,
  decodeSectorRecord,
  EMPTY_LEDGER,
  EMPTY_MEASURE_LEDGER,
  EMPTY_SECTOR_RECORD,
  holdoutsOf,
  isComplete,
  isStalled,
  type Ledger,
  ledgerArithmeticHolds,
  type MeasureLedger,
  measureLedgerArithmeticHolds,
  measureProgressOf,
  measureStandingOf,
  notedRecord,
  planDiffOf,
  planOf,
  positionOf,
  progressOf,
  reachedRecord,
  rebaselinedSector,
  reconcileEntries,
  reconcileSector,
  recordedOf,
  revokedRecord,
  sectorArithmeticHolds,
  serializeLedger,
  serializeMeasureLedger,
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

const campaign = (
  phases: CampaignRule["phases"],
  objectives: ReadonlyArray<string>,
): CompiledCampaign => {
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

  it("revokes an attestation without deleting it, and positions by the live ones only", () => {
    const rule = campaign(
      [
        { id: "a", objectives: [], attested: true, concessions: [], hash: "a" },
        { id: "b", objectives: [], attested: true, concessions: [], hash: "b" },
      ],
      [],
    );
    const attested = attestedRecord(
      attestedRecord(EMPTY_SECTOR_RECORD("c", "billing", T0), {
        phase: "a",
        reason: "ran",
        at: T0,
        by: "me",
      }),
      { phase: "b", reason: "read", at: T0, by: "me" },
    );
    expect([...positionOf(rule, attested).attested].sort()).toEqual(["a", "b"]);
    const revoked = revokedRecord(attested, ["a"], {
      at: T0 + DAY,
      by: "you",
      reason: "conceded x: temporary",
    });
    expect(revoked.attested).toHaveLength(2);
    expect(revoked.attested[0]?.revoked).toEqual({
      at: new Date(T0 + DAY).toISOString(),
      by: "you",
      reason: "conceded x: temporary",
    });
    expect([...positionOf(rule, revoked).attested]).toEqual(["b"]);
    // An attestation already revoked keeps its first revocation.
    expect(revokedRecord(revoked, ["a"], { at: T0 + 2 * DAY, by: "x", reason: "y" })).toEqual(
      revoked,
    );
    const decoded = decodeSectorRecord(JSON.parse(serializeSectorRecord(revoked)));
    expect(Result.isSuccess(decoded) && decoded.success).toEqual(revoked);
  });

  it("caps notes, round-trips, and refuses a malformed one", () => {
    let record = EMPTY_SECTOR_RECORD("c", "billing", T0);
    for (let i = 0; i < 20; i += 1) {
      const next = notedRecord(record, {
        at: T0 + i,
        by: "me",
        phase: "a",
        text: `note ${String(i)}`,
      });
      if (Result.isFailure(next)) throw new Error(next.failure);
      record = next.success;
    }
    // A 21st note is refused, and the 20 stand: nothing is dropped to make room.
    const crowded = notedRecord(record, { at: T0, by: "me", phase: "a", text: "one more" });
    expect(Result.isFailure(crowded) && crowded.failure).toContain("already holds 20 notes");
    expect(record.notes[0]?.text).toBe("note 0");
    // A long note is refused naming the limit and its length, never cut.
    const long = notedRecord(EMPTY_SECTOR_RECORD("c", "billing", T0), {
      at: T0,
      by: "me",
      phase: null,
      text: "x".repeat(600),
    });
    expect(Result.isFailure(long) && long.failure).toContain(
      "at most 500 characters, and this one is 600",
    );
    const whole = notedRecord(EMPTY_SECTOR_RECORD("c", "billing", T0), {
      at: T0,
      by: "me",
      phase: null,
      text: "x".repeat(500),
    });
    expect(Result.isSuccess(whole) && whole.success.notes[0]?.text.length).toBe(500);
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
    expect(planDiffOf(changed, before)).toEqual({
      refined: [],
      changed: ["a"],
      unreceipted: ["a"],
    });
    // With one: changed, and receipted.
    const receipted = campaign(
      [
        { ...phase("a", ["x"], "a2"), concessions: [{ reason: "r", at: "2026-09-20" }] },
        phase("b", []),
      ],
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

describe("a phase's identity", () => {
  const plan = (ids: ReadonlyArray<string>) =>
    campaign(
      ids.map((id) => phase(id, [`x-${id}`])),
      ids.map((id) => `x-${id}`),
    );

  it("is what it asks, so inserting a phase changes no other", () => {
    const before = planOf(plan(["a", "b", "c"]));
    expect(before.version).toBe(2);
    expect(planDiffOf(plan(["a", "new", "b", "c"]), before)).toEqual({
      refined: ["new"],
      changed: [],
      unreceipted: [],
    });
    expect(planDiffOf(plan(["first", "a", "b", "c"]), before).changed).toEqual([]);
  });

  it("includes where it stands among the others: a phase moved past another is a change", () => {
    const before = planOf(plan(["a", "b", "c", "d"]));
    // `c` and `b` swapped: one of the two moved, and that one needs a receipt.
    const swapped = planDiffOf(plan(["a", "c", "b", "d"]), before);
    expect(swapped.changed).toHaveLength(1);
    expect(["b", "c"]).toContain(swapped.changed[0]);
    expect(swapped.unreceipted).toEqual(swapped.changed);
    // `a` carried to the end: only `a` moved.
    expect(planDiffOf(plan(["b", "c", "d", "a"]), before)).toEqual({
      refined: [],
      changed: ["a"],
      unreceipted: ["a"],
    });
    const moved = plan(["b", "c", "d", "a"]);
    const receipted = {
      ...moved,
      phases: moved.phases.map((one) =>
        one.id === "a" ? { ...one, concessions: [{ reason: "r", at: "2026-10-01" }] } : one,
      ),
    };
    expect(planDiffOf(receipted, before)).toEqual({ refined: [], changed: ["a"], unreceipted: [] });
  });

  it("reads a version 1 plan exactly: the digest it recorded, at the index it recorded it at", () => {
    // What a phase asks, as the lowering carries it, and the hash a version 1
    // plan wrote for it: the digest of that with the phase's index in it.
    const asked = (id: string) => ({ id, attested: false, endState: null, objectives: [id] });
    const defined = (id: string, definition: unknown = asked(id)) => ({
      ...phase(id, [`x-${id}`], digest(definition)),
      definition,
    });
    const rule = (phases: ReadonlyArray<ReturnType<typeof defined>>) =>
      campaign(
        phases,
        phases.map((one) => `x-${one.id}`),
      );
    const recorded = {
      version: 1 as const,
      campaign: "c",
      phases: ["a", "b"].map((id, index) => ({
        id,
        hash: digest({ ...asked(id), index }),
        defined: true,
        concessions: 0,
      })),
    };
    expect(Result.isSuccess(decodePlanRecord(recorded))).toBe(true);
    const none = { refined: [], changed: [], unreceipted: [] };
    expect(planDiffOf(rule([defined("a"), defined("b")]), recorded)).toEqual(none);
    // The insertion that once changed every later phase.
    expect(planDiffOf(rule([defined("a"), defined("new"), defined("b")]), recorded)).toEqual({
      ...none,
      refined: ["new"],
    });
    // What a phase asks still counts.
    const widened = defined("b", { ...asked("b"), attested: true });
    expect(planDiffOf(rule([defined("a"), widened]), recorded)).toEqual({
      refined: [],
      changed: ["b"],
      unreceipted: ["b"],
    });
  });
});

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

  it("round-trips through the file, and is told apart from a holdout ledger by its kind", () => {
    const ledger = clearedMeasure(entered(14.2), "billing", 9.8, 0, T0 + DAY, "inside");
    const raw = JSON.parse(serializeMeasureLedger(ledger)) as unknown;
    const decoded = decodeMeasureLedger(raw);
    expect(Result.isSuccess(decoded) && decoded.success).toEqual(ledger);
    expect(Result.isFailure(decodeLedger(raw))).toBe(true);
    expect(
      Result.isFailure(decodeMeasureLedger(JSON.parse(serializeLedger(ledgerOf(["a.ts"]))))),
    ).toBe(true);
  });
});

const fail = (): never => {
  throw new Error("missing");
};
