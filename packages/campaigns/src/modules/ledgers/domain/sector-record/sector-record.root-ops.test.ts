import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import { compileCampaignRule, type CompiledCampaign } from "../../../../core/campaigns.js";
import type { CampaignRule } from "../../../../domain/config.js";
import { EMPTY_SECTOR_RECORD } from "./sector-record.root.js";
import {
  attestedRecord,
  notedRecord,
  positionOf,
  reachedRecord,
  revokedRecord,
} from "./sector-record.root-ops.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 15);

const campaign = (
  phases: CampaignRule["phases"],
  objectives: ReadonlyArray<string>,
): CompiledCampaign => {
  const compiled = compileCampaignRule({
    name: "campaign/c",
    id: "c",
    scope: "^src/",
    extensions: [],
    phases,
    objectives: objectives.map((id) => ({
      name: `campaign/c/${id}`,
      id,
      campaign: "c",
      message: "m",
      holdout: "file",
      match: { path: { file: "." } },
      probes: { fires: [], ignores: [] },
    })),
    onComplete: "keep",
  });

  if (Result.isFailure(compiled)) throw compiled.failure;

  return compiled.success;
};

const phase = (id: string, objectives: ReadonlyArray<string>, hash = id) => ({
  id,
  objectives,
  attested: false,
  concessions: [],
  hash,
});

describe("the sector record", () => {
  it("only advances reached, and reads it back as an index", () => {
    const rule = campaign([phase("a", ["x"]), phase("b", ["y"]), phase("c", [])], ["x", "y"]);
    const fresh = EMPTY_SECTOR_RECORD("c", "billing", T0);
    expect(positionOf(rule, fresh).reached).toBe(-1);
    expect(positionOf(rule, undefined).reached).toBe(-1);
    const atB = reachedRecord(fresh, rule, 1, T0 + DAY);
    expect(atB.reached).toBe("b");
    expect(atB.since).toBe(new Date(T0 + DAY).toISOString());
    expect(positionOf(rule, atB).reached).toBe(1);
    expect(reachedRecord(atB, rule, 0, T0 + 2 * DAY)).toBe(atB);
    expect(reachedRecord(atB, rule, 1, T0 + 2 * DAY)).toBe(atB);
    expect(reachedRecord(atB, rule, 3, T0 + 2 * DAY)).toBe(atB);
  });

  it("revokes an attestation without deleting it, and positions by the live ones only", () => {
    const rule = campaign(
      [
        { id: "a", objectives: [], attested: true, concessions: [], hash: "a" },
        { id: "b", objectives: [], attested: true, concessions: [], hash: "b" },
      ],
      [],
    );

    const attested = attestedRecord(
      attestedRecord(EMPTY_SECTOR_RECORD("c", "billing", T0), {
        phase: "a",
        reason: "ran",
        at: T0,
        by: "me",
      }),
      { phase: "b", reason: "read", at: T0, by: "me" },
    );

    expect([...positionOf(rule, attested).attested].sort()).toEqual(["a", "b"]);

    const revoked = revokedRecord(attested, ["a"], {
      at: T0 + DAY,
      by: "you",
      reason: "conceded x: temporary",
    });

    expect(revoked.attested).toHaveLength(2);
    expect(revoked.attested[0]?.revoked).toEqual({
      at: new Date(T0 + DAY).toISOString(),
      by: "you",
      reason: "conceded x: temporary",
    });
    expect([...positionOf(rule, revoked).attested]).toEqual(["b"]);
    // An attestation already revoked keeps its first revocation.
    expect(revokedRecord(revoked, ["a"], { at: T0 + 2 * DAY, by: "x", reason: "y" })).toEqual(
      revoked,
    );
  });

  it("caps notes, and refuses one too long, never cutting it", () => {
    let record = EMPTY_SECTOR_RECORD("c", "billing", T0);

    for (let i = 0; i < 20; i += 1) {
      const next = notedRecord(record, {
        at: T0 + i,
        by: "me",
        phase: "a",
        text: `note ${String(i)}`,
      });

      if (Result.isFailure(next)) throw new Error(next.failure);
      record = next.success;
    }

    // A 21st note is refused, and the 20 stand: nothing is dropped to make room.
    const crowded = notedRecord(record, { at: T0, by: "me", phase: "a", text: "one more" });
    expect(Result.isFailure(crowded) && crowded.failure).toContain("already holds 20 notes");
    expect(record.notes[0]?.text).toBe("note 0");

    // A long note is refused naming the limit and its length, never cut.
    const long = notedRecord(EMPTY_SECTOR_RECORD("c", "billing", T0), {
      at: T0,
      by: "me",
      phase: null,
      text: "x".repeat(600),
    });

    expect(Result.isFailure(long) && long.failure).toContain(
      "at most 500 characters, and this one is 600",
    );

    const whole = notedRecord(EMPTY_SECTOR_RECORD("c", "billing", T0), {
      at: T0,
      by: "me",
      phase: null,
      text: "x".repeat(500),
    });

    expect(Result.isSuccess(whole) && whole.success.notes[0]?.text.length).toBe(500);
  });
});
