import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import { attestSectorUseCase } from "./attest-sector.use-case.js";
import { load, TODO } from "./campaign.test-helper.js";

describe("attestSectorUseCase", () => {
  it("records the attestation in the sector's record, while the sector stands at the phase", () => {
    const { evaluation, policy, repositories } = load(TODO);

    const written = attestSectorUseCase(policy, evaluation, "src/b", "signed", {
      reason: "Read it.",
      evidence: undefined,
      by: "a@example.com",
    });

    expect(written).toEqual(Result.succeed(".architecture-campaigns/tidy/sectors/src%2Fb.json"));
    expect(repositories.sectorRecords.stored.get("tidy/src/b")?.attested).toEqual([
      {
        phase: "signed",
        reason: "Read it.",
        at: new Date(1e12).toISOString(),
        by: "a@example.com",
      },
    ]);
  });

  it("refuses an attestation ahead of where the sector stands", () => {
    const { evaluation, policy, repositories } = load(TODO);
    const entry = { reason: "Early.", evidence: undefined, by: "a@example.com" };

    expect(
      Result.isFailure(attestSectorUseCase(policy, evaluation, "src/a", "signed", entry)),
    ).toBe(true);
    expect(Result.isFailure(attestSectorUseCase(policy, evaluation, "src/a", "swept", entry))).toBe(
      true,
    );
    expect(
      Result.isFailure(attestSectorUseCase(policy, evaluation, "src/z", "signed", entry)),
    ).toBe(true);
    expect(repositories.sectorRecords.stored.size).toBe(0);
  });
});
