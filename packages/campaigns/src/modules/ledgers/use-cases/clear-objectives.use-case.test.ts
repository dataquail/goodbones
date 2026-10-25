import { describe, expect, it } from "vitest";

import { CLEAN, load, TODO } from "./campaign.test-helper.js";
import { clearObjectivesUseCase } from "./clear-objectives.use-case.js";

describe("clearObjectivesUseCase", () => {
  it("records each sector entering a window, the phase it reached, and the plan", () => {
    const { evaluation, policy, repositories } = load(TODO);
    const outcomes = clearObjectivesUseCase(policy, evaluation, null, "a@example.com");

    expect(outcomes.find((one) => one.objective === "no-todo")).toMatchObject({
      entered: ["src/a", "src/b"],
      left: 1,
    });
    expect(repositories.ledgers.stored.get("tidy/no-todo")).toMatchObject({
      sectors: { "src/a": { holdouts: ["x.ts"] }, "src/b": { holdouts: [] } },
    });
    expect(repositories.sectorRecords.stored.get("tidy/src/b")?.reached).toBe("signed");
    expect(repositories.plans.stored.has("tidy")).toBe(true);
  });

  it("clears what was fixed since, and with one objective named writes no record or plan", () => {
    const first = load(TODO);
    clearObjectivesUseCase(first.policy, first.evaluation, null, "a@example.com");
    const plan = first.repositories.plans.stored.get("tidy");

    const { evaluation, policy, repositories } = load(CLEAN, first);
    const [outcome] = clearObjectivesUseCase(policy, evaluation, "no-todo", "a@example.com");

    expect(outcome).toMatchObject({ objective: "no-todo", cleared: 1, left: 0 });
    expect(repositories.plans.stored.get("tidy")).toBe(plan);
  });
});
