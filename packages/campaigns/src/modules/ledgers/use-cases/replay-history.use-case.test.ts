import { describe, expect, it } from "vitest";

import { campaignsOf } from "../../../load/campaign-policy.js";
import { makeGitClientFake } from "../infrastructure/clients/git.client-fake.js";
import { fakes, load, TODO } from "./campaign.test-helper.js";
import { replayHistoryUseCase } from "./replay-history.use-case.js";

describe("replayHistoryUseCase", () => {
  it("replays each commit that touched the ledgers or the manifest, through git", () => {
    const ledger = (holdouts: ReadonlyArray<string>) =>
      JSON.stringify({ sectors: { "src/a": { holdouts } } });

    const at = ".architecture-campaigns/tidy/no-todo.json";

    const git = makeGitClientFake({
      refs: { one: { [at]: ledger(["x.ts", "y.ts"]) }, two: { [at]: ledger(["x.ts"]) } },
      commits: [
        { sha: "one", at: "2026-10-01T00:00:00Z", subject: "first", files: [at] },
        { sha: "two", at: "2026-10-02T00:00:00Z", subject: "second", files: [at, "arch.yaml"] },
      ],
    });

    const { policy } = load(TODO, { ...fakes(), git });
    const rule = campaignsOf(policy).campaignRules[0];

    if (rule === undefined) throw new Error("no campaign");

    expect(replayHistoryUseCase(policy, rule, null, ["arch.yaml"])).toEqual([
      {
        sha: "one",
        at: "2026-10-01T00:00:00Z",
        subject: "first",
        counts: { "no-todo": 2 },
        planChanged: false,
      },
      {
        sha: "two",
        at: "2026-10-02T00:00:00Z",
        subject: "second",
        counts: { "no-todo": 1 },
        planChanged: true,
      },
    ]);
  });
});
