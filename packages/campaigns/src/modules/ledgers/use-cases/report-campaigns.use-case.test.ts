import { describe, expect, it } from "vitest";

import { CLEAN, load, TODO } from "./campaign.test-helper.js";
import { clearObjectivesUseCase } from "./clear-objectives.use-case.js";
import { reportCampaignsUseCase } from "./report-campaigns.use-case.js";

describe("reportCampaignsUseCase", () => {
  it("reports a campaign no `clear` has recorded as missing its ledger", () => {
    const { evaluation, policy } = load(TODO);
    const [report] = reportCampaignsUseCase(policy, [evaluation]);

    expect(report).toMatchObject({ id: "tidy", count: 1, missingLedger: true });
  });

  it("reads the hits against the ledgers the policy was loaded with", () => {
    const first = load(TODO);
    clearObjectivesUseCase(first.policy, first.evaluation, null, "a@example.com");
    const fixed = load(CLEAN, first);
    const [report] = reportCampaignsUseCase(fixed.policy, [fixed.evaluation]);

    expect(report).toMatchObject({ missingLedger: false, count: 0, new: [] });
    expect(report?.stale).toEqual([{ objective: "no-todo", sector: "src/a", entry: "x.ts" }]);
  });
});
