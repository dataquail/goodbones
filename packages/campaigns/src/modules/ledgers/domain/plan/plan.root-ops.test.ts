import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import { compileCampaignRule, type CompiledCampaign } from "../../../../core/campaigns.js";
import type { CampaignRule } from "../../../../domain/config.js";
import { digest } from "../../../../domain/digest.js";
import { planDiffOf, planOf } from "./plan.root-ops.js";

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
