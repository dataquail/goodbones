import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { Violation } from "../domain/violation.js";
import {
  allowed,
  decodeLedger,
  EMPTY_LEDGER,
  entryOf,
  isComplete,
  isStalled,
  ledgerArithmeticHolds,
  ledgerOf,
  newEntriesOf,
  progressOf,
  pruned,
  reconcile,
  serializeLedger,
  staleEntriesOf,
} from "./ledger.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 15);

const hit = (file: string, subject: string | null = null): Violation => ({
  kind: "campaign",
  ruleName: "campaign/x",
  message: "m",
  file,
  subject,
});

describe("the arithmetic", () => {
  it("holds after init, prune and allow, and fails on a hand-added entry", () => {
    const initial = ledgerOf("x", [hit("a.ts"), hit("b.ts"), hit("c.ts")], T0);
    expect(initial.initial).toBe(3);
    expect(ledgerArithmeticHolds(initial)).toBe(true);

    const afterPrune = pruned(initial, [hit("a.ts")], "file", T0 + DAY);
    expect(afterPrune.entries).toEqual(["a.ts"]);
    expect(afterPrune.fixed).toBe(2);
    expect(ledgerArithmeticHolds(afterPrune)).toBe(true);

    const afterAllow = allowed(afterPrune, ["d.ts", "e.ts"], {
      at: T0 + 2 * DAY,
      by: "me",
      reason: "vendor",
    });
    expect(afterAllow.entries).toEqual(["a.ts", "d.ts", "e.ts"]);
    expect(afterAllow.regressions).toEqual([
      {
        at: new Date(T0 + 2 * DAY).toISOString(),
        by: "me",
        delta: 2,
        reason: "vendor",
        entries: ["d.ts", "e.ts"],
      },
    ]);
    expect(ledgerArithmeticHolds(afterAllow)).toBe(true);

    expect(ledgerArithmeticHolds({ ...afterAllow, entries: [...afterAllow.entries, "f.ts"] })).toBe(
      false,
    );
  });

  it("allowing an entry already present is not growth", () => {
    const ledger = ledgerOf("x", [hit("a.ts")], T0);
    expect(allowed(ledger, ["a.ts"], { at: T0, by: "me", reason: "r" })).toBe(ledger);
  });
});

describe("prune", () => {
  it("stamps lastProgress only when something was removed", () => {
    const ledger = ledgerOf("x", [hit("a.ts"), hit("b.ts")], T0);
    expect(pruned(ledger, [hit("a.ts"), hit("b.ts")], "file", T0 + DAY).lastProgress).toBe(
      ledger.lastProgress,
    );
    expect(pruned(ledger, [hit("a.ts")], "file", T0 + DAY).lastProgress).toBe(
      new Date(T0 + DAY).toISOString(),
    );
  });

  it("rewrites a match entry whose hash drifted under a still-present anchor, counting it as neither", () => {
    const ledger = ledgerOf("x", [hit("a.ts", "Foo#11111111"), hit("a.ts", "Foo#22222222")], T0);
    const now = [hit("a.ts", "Foo#11111111"), hit("a.ts", "Foo#33333333")];
    const state = reconcile(ledger, now, "match");
    expect(state.stale).toEqual([]);
    expect(state.unrecorded).toEqual([]);
    expect(state.drifted).toEqual([{ from: "a.ts#Foo#22222222", to: "a.ts#Foo#33333333" }]);
    const after = pruned(ledger, now, "match", T0 + DAY);
    expect(after.entries).toEqual(["a.ts#Foo#11111111", "a.ts#Foo#33333333"]);
    expect(after.fixed).toBe(0);
    expect(after.lastProgress).toBe(ledger.lastProgress);
    // A second match under the anchor beyond what the ledger carries is growth.
    expect(newEntriesOf(ledger, [...now, hit("a.ts", "Foo#44444444")], "match")).toEqual([
      "a.ts#Foo#44444444",
    ]);
    // A declaration campaign pairs nothing: a renamed declaration is fixed and new.
    expect(
      staleEntriesOf(ledgerOf("x", [hit("a.ts", "Foo")], T0), [hit("a.ts", "Bar")], "declaration"),
    ).toEqual(["a.ts#Foo"]);
  });
});

describe("progress, stalls and completion against a fixed clock", () => {
  it("measures progress against everything ever allowed", () => {
    const ledger = allowed(
      pruned(
        ledgerOf("x", [hit("a.ts"), hit("b.ts"), hit("c.ts"), hit("d.ts")], T0),
        [hit("a.ts"), hit("b.ts")],
        "file",
        T0,
      ),
      ["e.ts"],
      { at: T0, by: "me", reason: "r" },
    );
    // 3 left of 5 ever allowed.
    expect(progressOf(ledger)).toBeCloseTo(0.4);
    expect(progressOf(EMPTY_LEDGER("x", T0))).toBe(1);
  });

  it("is stalled after staleAfter without progress, unless complete", () => {
    const rule = { staleAfter: 30 * DAY };
    const ledger = ledgerOf("x", [hit("a.ts")], T0);
    expect(isStalled(rule, ledger, T0 + 29 * DAY)).toBe(false);
    expect(isStalled(rule, ledger, T0 + 31 * DAY)).toBe(true);
    const done = pruned(ledger, [], "file", T0);
    expect(isComplete(done)).toBe(true);
    expect(isStalled(rule, done, T0 + 365 * DAY)).toBe(false);
  });
});

describe("the file", () => {
  it("round-trips through serialize and decode, and refuses a malformed one", () => {
    const ledger = ledgerOf("x", [hit("a.ts", "Foo")], T0);
    const decoded = decodeLedger(JSON.parse(serializeLedger(ledger)));
    expect(Result.isSuccess(decoded) && decoded.success).toEqual(ledger);
    expect(Result.isFailure(decodeLedger({ version: 1, entries: [] }))).toBe(true);
    expect(Result.isFailure(decodeLedger({ ...ledger, extra: 1 }))).toBe(true);
  });

  it("writes an entry as the file, with the subject after a hash", () => {
    expect(entryOf(hit("a.ts"))).toBe("a.ts");
    expect(entryOf(hit("a.ts", "Foo"))).toBe("a.ts#Foo");
  });
});
