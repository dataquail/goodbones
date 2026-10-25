import { describe, expect, it } from "vitest";

import { load, TODO } from "./campaign.test-helper.js";
import { explainCampaignUseCase } from "./explain-campaign.use-case.js";

describe("explainCampaignUseCase", () => {
  it("names the file's sector, its phase, and the objectives that fire on it", () => {
    const { evaluation, policy } = load(TODO);

    expect(explainCampaignUseCase(policy, evaluation, "src/a/x.ts")).toMatchObject({
      campaign: { id: "tidy", phases: 3 },
      sector: "src/a",
      shared: false,
      index: 0,
      phase: { id: "swept", open: false, attested: false, intent: null },
      inWindow: [{ id: "no-todo", firing: true }],
      measures: [],
    });
  });

  it("answers nothing for a file in no sector", () => {
    const { evaluation, policy } = load(TODO);

    expect(explainCampaignUseCase(policy, evaluation, "lib/x.ts")).toBeNull();
  });
});
