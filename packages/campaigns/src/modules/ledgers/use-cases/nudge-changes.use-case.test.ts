import { describe, expect, it } from "vitest";

import { CLEAN, load, TODO } from "./campaign.test-helper.js";
import { clearObjectivesUseCase } from "./clear-objectives.use-case.js";
import { nudgeChangesUseCase } from "./nudge-changes.use-case.js";

const touching = (file: string) => ({
  base: null,
  touched: new Map([[file, [{ start: 1, end: 1 }]]]),
  deleted: [],
  added: [],
});

describe("nudgeChangesUseCase", () => {
  it("says which sector a diff touched, the phase it stands at, and what holds it", () => {
    const { evaluation, policy } = load(TODO);

    const nudge = nudgeChangesUseCase(
      policy,
      [evaluation],
      touching("src/a/x.ts"),
      null,
      null,
      null,
    );

    expect(nudge).toMatchObject({ mode: "ledger", touched: ["src/a/x.ts"] });
    expect(nudge.sectors.map((one) => [one.sector, one.phase.id, one.holdouts.total])).toEqual([
      ["src/a", "swept", 1],
    ]);
  });

  it("concedes what a hotfix grew, through the ledgers' repositories", () => {
    const first = load(CLEAN);
    clearObjectivesUseCase(first.policy, first.evaluation, null, "a@example.com");
    const { evaluation, policy, repositories } = load(TODO, first);

    const nudge = nudgeChangesUseCase(
      policy,
      [evaluation],
      touching("src/a/x.ts"),
      null,
      "the release",
      "a@example.com",
    );

    expect(nudge.sectors[0]?.verdict).toBe("hotfix");
    expect(repositories.ledgers.stored.get("tidy/no-todo")).toMatchObject({
      sectors: { "src/a": { holdouts: ["x.ts"] } },
    });
  });
});
