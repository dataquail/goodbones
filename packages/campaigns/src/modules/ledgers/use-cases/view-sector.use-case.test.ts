import { describe, expect, it } from "vitest";

import { load, TODO } from "./campaign.test-helper.js";
import { viewSectorUseCase } from "./view-sector.use-case.js";

describe("viewSectorUseCase", () => {
  it("says where a sector stands and every holdout in window", () => {
    const { evaluation, policy } = load(TODO);

    expect(viewSectorUseCase(policy, evaluation, "src/a")).toMatchObject({
      campaign: "tidy",
      sector: "src/a",
      phase: { id: "swept", index: 0, of: 3, open: false, attested: false },
      reached: null,
      objectives: [
        {
          id: "no-todo",
          count: 1,
          holdouts: [{ file: "src/a/x.ts", line: null, subject: null }],
        },
      ],
    });
  });

  it("answers nothing for a sector the campaign does not birth", () => {
    const { evaluation, policy } = load(TODO);

    expect(viewSectorUseCase(policy, evaluation, "src/z")).toBeNull();
  });
});
