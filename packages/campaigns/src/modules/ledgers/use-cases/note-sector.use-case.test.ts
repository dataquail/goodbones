import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import { load, TODO } from "./campaign.test-helper.js";
import { noteSectorUseCase } from "./note-sector.use-case.js";

describe("noteSectorUseCase", () => {
  it("leaves a dated note under the phase the sector stands at", () => {
    const { evaluation, policy, repositories } = load(TODO);
    const written = noteSectorUseCase(policy, evaluation, "src/a", "Half done.", "a@example.com");

    expect(Result.isSuccess(written)).toBe(true);
    expect(repositories.sectorRecords.stored.get("tidy/src/a")?.notes).toEqual([
      { at: new Date(1e12).toISOString(), by: "a@example.com", phase: "swept", text: "Half done." },
    ]);
  });

  it("refuses a sector the campaign does not birth, and saves nothing", () => {
    const { evaluation, policy, repositories } = load(TODO);

    expect(Result.isFailure(noteSectorUseCase(policy, evaluation, "src/z", "x", "a"))).toBe(true);
    expect(repositories.sectorRecords.stored.size).toBe(0);
  });
});
