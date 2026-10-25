import { describe, expect, it } from "vitest";

import { attestSectorUseCase } from "./attest-sector.use-case.js";
import { CLEAN, load, TODO } from "./campaign.test-helper.js";
import { clearObjectivesUseCase } from "./clear-objectives.use-case.js";
import { nudgeChangesUseCase } from "./nudge-changes.use-case.js";

const touching = (file: string) => ({
  base: null,
  touched: new Map([[file, [{ start: 1, end: 1 }]]]),
  deleted: [],
  added: [],
});

describe("nudgeChangesUseCase", () => {
  it("says which sector a diff touched, the phase it stands at, and what holds it", () => {
    const { evaluation, policy } = load(TODO);

    const nudge = nudgeChangesUseCase(
      policy,
      [evaluation],
      touching("src/a/x.ts"),
      null,
      null,
      null,
    );

    expect(nudge).toMatchObject({ mode: "ledger", touched: ["src/a/x.ts"] });
    expect(nudge.sectors.map((one) => [one.sector, one.phase.id, one.holdouts.total])).toEqual([
      ["src/a", "swept", 1],
    ]);
  });

  it("concedes what a hotfix grew, through the ledgers' repositories", () => {
    const first = load(CLEAN);
    clearObjectivesUseCase(first.policy, first.evaluation, null, "a@example.com");
    const { evaluation, policy, repositories } = load(TODO, first);

    const nudge = nudgeChangesUseCase(
      policy,
      [evaluation],
      touching("src/a/x.ts"),
      null,
      "the release",
      "a@example.com",
    );

    expect(nudge.sectors[0]?.verdict).toBe("hotfix");
    expect(repositories.ledgers.stored.get("tidy/no-todo")).toMatchObject({
      sectors: { "src/a": { holdouts: ["x.ts"] } },
    });
  });

  it("revokes once what a hotfix sends a sector back across, whichever dimensions went back", () => {
    const first = load(CLEAN);
    clearObjectivesUseCase(first.policy, first.evaluation, null, "a@example.com");
    const signed = load(CLEAN, first);
    attestSectorUseCase(signed.policy, signed.evaluation, "src/a", "signed", {
      reason: "Read it.",
      evidence: undefined,
      by: "a@example.com",
    });
    const trimmed = load(CLEAN, first);
    clearObjectivesUseCase(trimmed.policy, trimmed.evaluation, null, "a@example.com");
    const grown = { ...TODO, "src/a/w.ts": "one\ntwo\n" };
    const { evaluation, policy, repositories } = load(grown, first);

    const nudge = nudgeChangesUseCase(
      policy,
      [evaluation],
      touching("src/a/x.ts"),
      null,
      "the release",
      "a@example.com",
    );

    expect(nudge.sectors[0]?.verdict).toBe("hotfix");
    expect(nudge.sectors[0]?.sentBack).toEqual({
      from: "trimmed",
      to: "swept",
      revoked: ["signed"],
    });
    expect(repositories.ledgers.stored.get("tidy/no-todo")).toMatchObject({
      sectors: { "src/a": { holdouts: ["x.ts"] } },
    });
    // Sent below the scalar's window, the sector owes it nothing to concede.
    expect(repositories.ledgers.stored.get("tidy/lines")).toMatchObject({ concessions: [] });
    expect(repositories.sectorRecords.stored.get("tidy/src/a")).toMatchObject({
      attested: [{ phase: "signed", revoked: { reason: "hotfix: the release" } }],
    });
  });
});
