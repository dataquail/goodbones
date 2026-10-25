import { describe, expect, it } from "vitest";

import { campaignsOf } from "../../../load/campaign-policy.js";
import { EMPTY_LEDGER } from "../domain/ledger/ledger.root.js";
import { makeGitClientFake } from "../infrastructure/clients/git.client-fake.js";
import { serializeLedger } from "../infrastructure/repositories/ledger.mapper.js";
import { fakes, load, TODO } from "./campaign.test-helper.js";
import { replayHistoryUseCase } from "./replay-history.use-case.js";

describe("replayHistoryUseCase", () => {
  it("replays each commit that touched the ledgers or the manifest, through the repositories at it", () => {
    const T = new Date(0).toISOString();

    const ledger = (holdouts: ReadonlyArray<string>) =>
      serializeLedger({
        ...EMPTY_LEDGER("tidy", "no-todo", 0),
        sectors: {
          "src/a": {
            entered: T,
            initial: 2,
            cleared: 2 - holdouts.length,
            closed: 0,
            lastCleared: T,
            holdouts,
          },
        },
      });

    const at = ".architecture-campaigns/tidy/no-todo.json";

    const git = makeGitClientFake({
      refs: {
        one: { [at]: ledger(["x.ts", "y.ts"]) },
        two: { [at]: ledger(["x.ts"]) },
        three: { [at]: "{ not a ledger" },
      },
      commits: [
        { sha: "one", at: "2026-10-01T00:00:00Z", subject: "first", files: [at] },
        { sha: "two", at: "2026-10-02T00:00:00Z", subject: "second", files: [at, "arch.yaml"] },
        { sha: "three", at: "2026-10-03T00:00:00Z", subject: "third", files: [at] },
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
      // A ledger that does not decode there contributes nothing.
      {
        sha: "three",
        at: "2026-10-03T00:00:00Z",
        subject: "third",
        counts: {},
        planChanged: false,
      },
    ]);
  });
});
