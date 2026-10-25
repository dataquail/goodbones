import { describe, expect, it } from "vitest";

import { CLEAN, load, TODO } from "./campaign.test-helper.js";
import { clearObjectivesUseCase } from "./clear-objectives.use-case.js";
import { previewSectorMovesUseCase } from "./preview-sector-moves.use-case.js";

describe("previewSectorMovesUseCase", () => {
  it("says nothing of a sector no `clear` has placed", () => {
    const { evaluation, policy } = load(TODO);

    expect(previewSectorMovesUseCase(policy, evaluation)).toEqual([]);
  });

  it("names the sector the working tree carried past where the ledgers placed it", () => {
    const first = load(TODO);
    clearObjectivesUseCase(first.policy, first.evaluation, null, "a@example.com");
    const { evaluation, policy } = load(CLEAN, first);

    expect(previewSectorMovesUseCase(policy, evaluation)).toEqual([
      { campaign: "tidy", sector: "src/a", from: "swept", to: "signed", back: false, passed: [] },
    ]);
  });
});
