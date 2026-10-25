import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import { CLEAN, load, TODO } from "../modules/ledgers/use-cases/campaign.test-helper.js";
import { clearObjectivesUseCase } from "../modules/ledgers/use-cases/clear-objectives.use-case.js";
import { concedeMeasure } from "./policy-signatures.js";

const receipt = { at: 1e12, by: "a@example.com", reason: "Needed for the release." };

describe("concedeMeasure", () => {
  it("refuses a holdout objective, and concedes nothing", () => {
    const first = load(CLEAN);
    clearObjectivesUseCase(first.policy, first.evaluation, null, "a@example.com");
    const { evaluation, policy, repositories } = load(TODO, first);
    const holdouts = evaluation.rule.objectives.find((one) => one.id === "no-todo");

    if (holdouts === undefined) throw new Error("no objective no-todo");
    const before = repositories.ledgers.stored.get("tidy/no-todo");

    expect(concedeMeasure(policy, evaluation, holdouts, null, receipt)).toEqual(
      Result.fail("objective tidy/no-todo has no ledger yet; run `objectives clear tidy` first."),
    );
    expect(repositories.ledgers.stored.get("tidy/no-todo")).toBe(before);
  });
});
