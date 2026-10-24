import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { makeFileSystemLive } from "@goodbones/core";
import * as Result from "effect/Result";
import { describe, expect, it, onTestFinished } from "vitest";

import { EMPTY_SECTOR_RECORD } from "../../domain/sector-record/sector-record.root.js";
import {
  attestedRecord,
  revokedRecord,
} from "../../domain/sector-record/sector-record.root-ops.js";
import { makeSectorRecordsRepositoryLive } from "./sector-records.repository-live.js";

const T0 = Date.UTC(2026, 8, 15);
const DIR = ".architecture-campaigns";

const sectors = path.join(DIR, "c", "sectors");

const record = revokedRecord(
  attestedRecord(EMPTY_SECTOR_RECORD("c", "apps/web", T0), {
    phase: "a",
    reason: "reviewed",
    at: T0,
    by: "me",
  }),
  ["a"],
  { at: T0 + 1, by: "me", reason: "conceded" },
);

// Tests run concurrently, so each one is given a repository root of its own.
const scratch = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "records-")));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const repository = () =>
    makeSectorRecordsRepositoryLive({
      fileSystem: makeFileSystemLive(root),
      repoRoot: root,
      ledgerDir: DIR,
    });

  const place = (name: string, text: string): void => {
    mkdirSync(path.join(root, sectors), { recursive: true });
    writeFileSync(path.join(root, sectors, name), text);
  };

  return { root, repository, place };
};

describe("the sector records repository", () => {
  it("finds none before one is saved", () => {
    const { repository } = scratch();
    expect(repository().findAll("c")).toEqual(Result.succeed([]));
  });

  it("saves a record under its sector's encoded name, in the format on disk, and reads it back", () => {
    const { repository, root } = scratch();
    repository().save(record);

    expect(readFileSync(path.join(root, sectors, "apps%2Fweb.json"), "utf8")).toBe(
      `${JSON.stringify(record, null, 2)}\n`,
    );
    expect(repository().findAll("c")).toEqual(Result.succeed([record]));
  });

  it("reads only the JSON files, in the order they sort", () => {
    const { place, repository } = scratch();
    repository().save(EMPTY_SECTOR_RECORD("c", "b", T0));
    repository().save(EMPTY_SECTOR_RECORD("c", "a", T0));
    place("notes.txt", "not a record");
    const found = repository().findAll("c");

    expect(Result.isSuccess(found) && found.success.map((one) => one.sector)).toEqual(["a", "b"]);
  });

  it("refuses a record that is not JSON, not a record, or another campaign's", () => {
    const { place, repository } = scratch();

    const refusalOf = (text: string) => {
      place("x.json", text);
      const found = repository().findAll("c");

      return Result.isFailure(found) ? [found.failure.reason, found.failure.detail] : null;
    };

    expect(refusalOf("{")?.[0]).toBe("not-json");
    expect(refusalOf(JSON.stringify({ version: 1 }))?.[0]).toBe("undecodable");
    expect(refusalOf(JSON.stringify(EMPTY_SECTOR_RECORD("d", "x", T0)))).toEqual([
      "misplaced",
      "d",
    ]);
  });
});
