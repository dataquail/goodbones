import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { CampaignRule, ObjectiveRule } from "../domain/config.js";
import { compileCampaignRule, type CompiledCampaign } from "./campaigns.js";
import {
  compareResidue,
  derivePhase,
  donePhaseOf,
  inWindow,
  isOpenPhase,
  ladderPositionOf,
  ledgeredFor,
  objectivesInWindow,
  onTouchOf,
  sharedWindow,
  stepsOf,
  UNPLACED,
  windowOf,
  worsened,
} from "./phases.js";

const objective = (id: string, until?: string): ObjectiveRule => ({
  name: `campaign/c/${id}`,
  id,
  campaign: "c",
  message: "m",
  holdout: "file",
  match: { path: { file: "." } },
  ...(until === undefined ? {} : { until }),
  probes: { fires: [], ignores: [] },
});

const phase = (
  id: string,
  objectives: ReadonlyArray<string>,
  extra: Partial<CampaignRule["phases"][number]> = {},
): CampaignRule["phases"][number] => ({
  id,
  objectives,
  attested: false,
  concessions: [],
  hash: id,
  ...extra,
});

// The billing ladder from the design: domain → repository → dual-write
// (windowed) → backfilled (attested) → cutover → aggregates (open).
const billing = (): CompiledCampaign => {
  const compiled = compileCampaignRule({
    name: "campaign/c",
    id: "c",
    scope: "^src/",
    extensions: [],
    phases: [
      phase("domain", ["no-io"]),
      phase("repository", ["no-raw-queries"]),
      phase("dual-write", ["has-flag"]),
      phase("backfilled", [], { attested: true }),
      phase("cutover", ["no-flag"]),
      phase("aggregates", [], { intent: "undecided" }),
    ],
    objectives: [
      objective("no-io"),
      objective("no-raw-queries"),
      objective("has-flag", "cutover"),
      objective("no-flag"),
      objective("legacy-lines"),
    ],
    onComplete: "keep",
  });
  if (Result.isFailure(compiled)) throw compiled.failure;
  return compiled.success;
};

const find = (rule: CompiledCampaign, id: string) => {
  const found = rule.objectives.find((one) => one.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};

describe("windows", () => {
  it("run from the naming phase to `until`, exclusive; an unnamed objective runs everywhere", () => {
    const rule = billing();
    expect(windowOf(rule, find(rule, "no-io"))).toEqual({
      from: 0,
      until: Number.POSITIVE_INFINITY,
    });
    expect(windowOf(rule, find(rule, "has-flag"))).toEqual({ from: 2, until: 4 });
    expect(windowOf(rule, find(rule, "legacy-lines"))).toEqual({
      from: -1,
      until: Number.POSITIVE_INFINITY,
    });
    expect(inWindow(rule, find(rule, "has-flag"), 1, UNPLACED)).toBe(false);
    expect(inWindow(rule, find(rule, "has-flag"), 2, UNPLACED)).toBe(true);
    expect(inWindow(rule, find(rule, "has-flag"), 3, UNPLACED)).toBe(true);
    expect(inWindow(rule, find(rule, "has-flag"), 4, UNPLACED)).toBe(false);
    // A window the sector has passed never reopens for it.
    expect(inWindow(rule, find(rule, "has-flag"), 2, { reached: 4, attested: new Set() })).toBe(
      false,
    );
    expect(inWindow(rule, find(rule, "has-flag"), 2, { reached: 3, attested: new Set() })).toBe(
      true,
    );
    expect(objectivesInWindow(rule, 0, UNPLACED).map((one) => one.id)).toEqual([
      "no-io",
      "legacy-lines",
    ]);
    expect(objectivesInWindow(rule, 4, UNPLACED).map((one) => one.id)).toEqual([
      "no-io",
      "no-raw-queries",
      "no-flag",
      "legacy-lines",
    ]);
  });
});

describe("the shared files' window", () => {
  // A prerequisite named by the second phase, a rule of the shared files' own
  // named by none, and a scalar no phase names.
  const shared = (): CompiledCampaign => {
    const compiled = compileCampaignRule({
      name: "campaign/c",
      id: "c",
      scope: "^src/",
      extensions: [],
      shared: "^src/platform/",
      phases: [phase("fenced", ["no-io"]), phase("rebuilt", ["has-guard"])],
      objectives: [
        objective("no-io"),
        { ...objective("has-guard"), over: "shared" },
        { ...objective("no-raw-sql"), over: "shared" },
        {
          name: "campaign/c/lines",
          id: "lines",
          campaign: "c",
          message: "m",
          measure: { lines: true },
          probes: { fires: [], ignores: [] },
        },
      ],
      onComplete: "keep",
    });
    if (Result.isFailure(compiled)) throw compiled.failure;
    return compiled.success;
  };

  it("is everything read over it, and every scalar no phase names", () => {
    expect(sharedWindow(shared()).map((one) => one.id)).toEqual([
      "has-guard",
      "no-raw-sql",
      "lines",
    ]);
  });

  it("puts a prerequisite in a sector's window from the phase naming it, and the shared files' own rules in none", () => {
    const rule = shared();
    const ids = (at: number) => objectivesInWindow(rule, at, UNPLACED).map((one) => one.id);
    expect(ids(0)).toEqual(["no-io", "lines"]);
    // Named by `rebuilt`: every sector there waits on it.
    expect(ids(1)).toEqual(["no-io", "has-guard", "lines"]);
    // The prerequisite places a sector as its own objectives do.
    expect(derivePhase(rule, (id) => (id === "has-guard" ? 1 : 0), UNPLACED)).toBe(1);
    expect(derivePhase(rule, () => 0, UNPLACED)).toBe(2);
    // And it is ledgered in one place.
    expect(ledgeredFor(rule, find(rule, "has-guard"), "billing")).toBe(false);
    expect(ledgeredFor(rule, find(rule, "has-guard"), "shared")).toBe(true);
    expect(ledgeredFor(rule, find(rule, "no-io"), "billing")).toBe(true);
  });
});

describe("the derived phase", () => {
  it("is the first phase with residue: a holdout, an unattested step, or the open phase", () => {
    const rule = billing();
    const at = (counts: Readonly<Record<string, number>>, attested: ReadonlyArray<string> = []) =>
      derivePhase(rule, (id) => counts[id] ?? 0, { reached: -1, attested: new Set(attested) });
    expect(at({ "no-io": 3, "no-raw-queries": 7 })).toBe(0);
    expect(at({ "no-raw-queries": 7 })).toBe(1);
    expect(at({ "has-flag": 1 })).toBe(2);
    expect(at({})).toBe(3);
    expect(at({}, ["backfilled"])).toBe(5);
    expect(at({ "no-flag": 2 }, ["backfilled"])).toBe(4);
    // An objective no phase names never places a sector.
    expect(at({ "legacy-lines": 40 }, ["backfilled"])).toBe(5);
    // The open phase is always residue: nothing the code does leaves it.
    const last = rule.phases[5];
    expect(last !== undefined && isOpenPhase(last)).toBe(true);
    // A shut window is not residue: a sector that reached cutover and lost
    // its flag is not sent back to dual-write.
    expect(
      derivePhase(rule, (id) => (id === "has-flag" ? 1 : 0), {
        reached: 4,
        attested: new Set(["backfilled"]),
      }),
    ).toBe(5);
  });

  it("is done past the last phase of a ladder that ends defined", () => {
    const compiled = compileCampaignRule({
      name: "campaign/c",
      id: "c",
      scope: "^src/",
      extensions: [],
      phases: [phase("a", ["x"])],
      objectives: [objective("x")],
      onComplete: "keep",
    });
    if (Result.isFailure(compiled)) throw compiled.failure;
    expect(derivePhase(compiled.success, () => 0, UNPLACED)).toBe(donePhaseOf(compiled.success));
    expect(derivePhase(compiled.success, () => 0, UNPLACED)).toBe(1);
  });
});

describe("onTouch", () => {
  it("is the phase's word, else the campaign's, else by definedness", () => {
    const rule = billing();
    expect(onTouchOf(rule, 0)).toBe("ratchet");
    expect(onTouchOf(rule, 5)).toBe("advise");
    expect(onTouchOf({ ...rule, onTouch: "paydown" }, 5)).toBe("paydown");
    const overridden: CompiledCampaign = {
      ...rule,
      phases: rule.phases.map((one, i) => (i === 0 ? { ...one, onTouch: "advise" } : one)),
    };
    expect(onTouchOf(overridden, 0)).toBe("advise");
    expect(onTouchOf(rule, 6)).toBe("ratchet");
  });
});

describe("a sector's position on the ladder", () => {
  it("is the phases behind it plus the share of its phase that is paid, and never falls on entry", () => {
    const rule = billing();
    // Five defined phases; the open one is where the plan runs out.
    expect(stepsOf(rule)).toBe(5);
    const at = (phase: number, shares: Readonly<Record<string, number>> = {}) =>
      ladderPositionOf(rule, phase, (id) => shares[id] ?? 0);
    // Entering a phase: exactly its index, whatever the phase holds.
    expect(at(1)).toBe(1);
    // Paying it down: toward the next index.
    expect(at(1, { "no-raw-queries": 0.5 })).toBe(1.5);
    expect(at(1, { "no-raw-queries": 1 })).toBe(2);
    // An attested phase counts nothing down.
    expect(at(3)).toBe(3);
    // The open phase, and past the last: every step taken.
    expect(at(5)).toBe(5);
    expect(at(6)).toBe(5);
    // Never out of its own phase, whatever a share says.
    expect(at(0, { "no-io": 7 })).toBe(1);
    expect(at(0, { "no-io": -1 })).toBe(0);
  });
});

describe("the residue vector", () => {
  it("is compared by dominance, never by a sum", () => {
    expect(compareResidue({ a: 3, b: 1 }, { a: 2, b: 1 })).toBe("forward");
    expect(compareResidue({ a: 3, b: 1 }, { a: 3, b: 2 })).toBe("back");
    expect(compareResidue({ a: 3, b: 1 }, { a: 1, b: 2 })).toBe("mixed");
    expect(compareResidue({ a: 3 }, { a: 3 })).toBe("neutral");
    expect(compareResidue({}, { a: 1 })).toBe("back");
    expect(worsened({ a: 3, b: 1 }, { a: 1, b: 2, c: 1 })).toEqual(["b", "c"]);
  });
});
