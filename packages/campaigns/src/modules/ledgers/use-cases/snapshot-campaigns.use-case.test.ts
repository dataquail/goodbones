import { describe, expect, it } from "vitest";

import { load, TODO } from "./campaign.test-helper.js";
import { clearObjectivesUseCase } from "./clear-objectives.use-case.js";
import { snapshotCampaignsUseCase } from "./snapshot-campaigns.use-case.js";

describe("snapshotCampaignsUseCase", () => {
  it("places each sector on the ladder and counts what is left", () => {
    const first = load(TODO);
    clearObjectivesUseCase(first.policy, first.evaluation, null, "a@example.com");
    const { evaluation, policy } = load(TODO, first);
    const [snapshot] = snapshotCampaignsUseCase(policy, [evaluation]);

    expect(snapshot).toMatchObject({ id: "tidy", count: 1, steps: 3, ledgered: true });
    expect(snapshot?.phases.map((one) => [one.id, one.sectors])).toEqual([
      ["swept", 1],
      ["signed", 1],
      ["trimmed", 0],
    ]);
    expect(snapshot?.sectors.map((one) => [one.name, one.phase, one.reached])).toEqual([
      ["src/a", "swept", "swept"],
      ["src/b", "signed", "signed"],
    ]);
  });
});
