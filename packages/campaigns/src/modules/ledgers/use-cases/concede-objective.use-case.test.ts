import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import { CLEAN, load, TODO } from "./campaign.test-helper.js";
import { clearObjectivesUseCase } from "./clear-objectives.use-case.js";
import { concedeObjectiveUseCase } from "./concede-objective.use-case.js";

const receipt = { at: 1e12, by: "a@example.com", reason: "Needed for the release." };

describe("concedeObjectiveUseCase", () => {
  it("refuses an objective with no ledger yet", () => {
    const { evaluation, policy } = load(TODO);

    expect(
      Result.isFailure(concedeObjectiveUseCase(policy, evaluation, "no-todo", null, null, receipt)),
    ).toBe(true);
  });

  it("joins the unrecorded hits to the ledger, with the reason and the author", () => {
    const first = load(CLEAN);
    clearObjectivesUseCase(first.policy, first.evaluation, null, "a@example.com");
    const { evaluation, policy, repositories } = load(TODO, first);
    const done = concedeObjectiveUseCase(policy, evaluation, "no-todo", null, null, receipt);

    expect(done).toEqual(
      Result.succeed({
        objective: "no-todo",
        conceded: [{ sector: "src/a", entry: "x.ts" }],
        left: [],
        sentBack: [{ sector: "src/a", from: "signed", to: "swept", revoked: [] }],
      }),
    );
    expect(repositories.ledgers.stored.get("tidy/no-todo")).toMatchObject({
      sectors: { "src/a": { holdouts: ["x.ts"] } },
    });
  });

  it("refuses a holdout that is not an unrecorded hit, and a choice among a scalar's", () => {
    const first = load(CLEAN);
    clearObjectivesUseCase(first.policy, first.evaluation, null, "a@example.com");
    const { evaluation, policy } = load(TODO, first);

    expect(
      Result.isFailure(
        concedeObjectiveUseCase(policy, evaluation, "no-todo", ["y.ts"], null, receipt),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(concedeObjectiveUseCase(policy, evaluation, "lines", ["x"], null, receipt)),
    ).toBe(true);
  });
});
