import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { makeFileSystemLive } from "@goodbones/core";
import * as Result from "effect/Result";
import { describe, expect, it, onTestFinished } from "vitest";

import { IMPLICIT_SECTOR } from "../../../../core/sectors.js";
import { EMPTY_LEDGER } from "../../domain/ledger/ledger.root.js";
import { clearedSector, ledgerArithmeticHolds } from "../../domain/ledger/ledger.root-ops.js";
import { EMPTY_MEASURE_LEDGER } from "../../domain/measure-ledger/measure-ledger.root.js";
import { clearedMeasure } from "../../domain/measure-ledger/measure-ledger.root-ops.js";
import { makeObjectiveLedgersRepositoryLive } from "./objective-ledgers.repository-live.js";

const T0 = Date.UTC(2026, 8, 15);
const DIR = ".architecture-campaigns";

const ledger = clearedSector(
  EMPTY_LEDGER("c", "o", T0),
  "billing",
  ["a.ts#Foo"],
  "file",
  T0,
  "inside",
);

// Tests run concurrently, so each one is given a repository root of its own.
const scratch = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ledgers-")));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const repository = () =>
    makeObjectiveLedgersRepositoryLive({
      fileSystem: makeFileSystemLive(root),
      repoRoot: root,
      ledgerDir: DIR,
    });

  const place = (at: string, text: string): void => {
    mkdirSync(path.dirname(path.join(root, at)), { recursive: true });
    writeFileSync(path.join(root, at), text);
  };

  return { root, repository, place };
};

describe("the objective ledgers repository", () => {
  it("finds no ledger before one is saved", () => {
    const { repository } = scratch();
    expect(repository().findOne({ campaign: "c", objective: "o" })).toEqual(Result.succeed(null));
  });

  it("saves a ledger where its objective lives, in the format on disk, and reads it back", () => {
    const { repository, root } = scratch();
    repository().save(ledger);

    expect(readFileSync(path.join(root, DIR, "c", "o.json"), "utf8")).toBe(
      `${JSON.stringify(ledger, null, 2)}\n`,
    );
    expect(repository().findOne({ campaign: "c", objective: "o" })).toEqual(Result.succeed(ledger));
  });

  it("tells a scalar objective's ledger apart by its kind", () => {
    const { repository } = scratch();

    const measured = clearedMeasure(
      EMPTY_MEASURE_LEDGER("c", "m", "down", T0),
      "billing",
      14.2,
      0,
      T0,
      "inside",
    );

    repository().save(measured);
    const found = repository().findOne({ campaign: "c", objective: "m" });

    expect(found).toEqual(Result.succeed(measured));
  });

  it("refuses a file that is not JSON, not a ledger, or another objective's", () => {
    const { place, repository } = scratch();

    const reasonOf = (text: string) => {
      place(`${DIR}/c/o.json`, text);
      const found = repository().findOne({ campaign: "c", objective: "o" });

      return Result.isFailure(found) ? found.failure.reason : null;
    };

    expect(reasonOf("{")).toBe("not-json");
    expect(reasonOf(JSON.stringify({ version: 2, sectors: {} }))).toBe("undecodable");
    expect(reasonOf(JSON.stringify({ ...ledger, extra: 1 }))).toBe("undecodable");
    expect(reasonOf(JSON.stringify({ ...ledger, objective: "p" }))).toBe("misplaced");

    place(`${DIR}/c/o.json`, JSON.stringify({ kind: "measure" }));
    const wrong = repository().findOne({ campaign: "c", objective: "o" });

    expect(Result.isFailure(wrong) && wrong.failure.measure).toBe(true);
  });

  it("reads the family's first layout as one sector, the implicit one, and removes it", () => {
    const { place, repository } = scratch();
    place(
      `${DIR}/x.json`,
      JSON.stringify({
        version: 1,
        id: "x",
        created: "2026-09-15T00:00:00.000Z",
        initial: 3,
        fixed: 1,
        lastProgress: "2026-09-16T00:00:00.000Z",
        regressions: [
          { at: "2026-09-17T00:00:00.000Z", by: "me", delta: 1, reason: "r", entries: ["c.ts"] },
        ],
        entries: ["a.ts", "b.ts", "c.ts"],
      }),
    );

    const found = repository().findOne({ campaign: "x", objective: null });

    expect(Result.isSuccess(found) && found.success).toEqual({
      version: 2,
      campaign: "x",
      objective: "x",
      created: "2026-09-15T00:00:00.000Z",
      sectors: {
        [IMPLICIT_SECTOR]: {
          entered: "2026-09-15T00:00:00.000Z",
          initial: 3,
          cleared: 1,
          closed: 0,
          lastCleared: "2026-09-16T00:00:00.000Z",
          holdouts: ["a.ts", "b.ts", "c.ts"],
        },
      },
      concessions: [
        {
          sector: IMPLICIT_SECTOR,
          at: "2026-09-17T00:00:00.000Z",
          by: "me",
          delta: 1,
          reason: "r",
          holdouts: ["c.ts"],
        },
      ],
    });
    expect(
      Result.isSuccess(found) &&
        found.success !== null &&
        !("kind" in found.success) &&
        ledgerArithmeticHolds(found.success),
    ).toBe(true);

    repository().remove({ campaign: "x", objective: null });

    expect(repository().findOne({ campaign: "x", objective: null })).toEqual(Result.succeed(null));
  });

  it("refuses a file at the first layout's path that is in another layout", () => {
    const { place, repository } = scratch();
    place(`${DIR}/c.json`, JSON.stringify(ledger));
    const found = repository().findOne({ campaign: "c", objective: null });

    expect(Result.isFailure(found) && found.failure.reason).toBe("not-first-layout");
  });
});
