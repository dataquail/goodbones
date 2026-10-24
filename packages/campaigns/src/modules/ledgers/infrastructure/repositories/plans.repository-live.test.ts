import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { makeFileSystemLive } from "@goodbones/core";
import * as Result from "effect/Result";
import { describe, expect, it, onTestFinished } from "vitest";

import type { PlanRecord } from "../../domain/plan/plan.root.js";
import { makePlansRepositoryLive } from "./plans.repository-live.js";

const DIR = ".architecture-campaigns";

const at = path.join(DIR, "c", "plan.json");

const plan: PlanRecord = {
  version: 2,
  campaign: "c",
  phases: [{ id: "a", hash: "h", defined: true, concessions: 0 }],
};

// Tests run concurrently, so each one is given a repository root of its own.
const scratch = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "plans-")));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const repository = () =>
    makePlansRepositoryLive({
      fileSystem: makeFileSystemLive(root),
      repoRoot: root,
      ledgerDir: DIR,
    });

  const place = (text: string): void => {
    mkdirSync(path.dirname(path.join(root, at)), { recursive: true });
    writeFileSync(path.join(root, at), text);
  };

  return { root, repository, place };
};

describe("the plans repository", () => {
  it("finds no plan before the first clear", () => {
    const { repository } = scratch();
    expect(repository().findOne("c")).toEqual(Result.succeed(null));
  });

  it("saves a plan in the format on disk, and reads it back", () => {
    const { repository, root } = scratch();
    repository().save(plan);

    expect(readFileSync(path.join(root, at), "utf8")).toBe(`${JSON.stringify(plan, null, 2)}\n`);
    expect(repository().findOne("c")).toEqual(Result.succeed(plan));
  });

  it("reads a version 1 plan as it was recorded", () => {
    const { place, repository } = scratch();
    const old = { ...plan, version: 1 as const };
    place(JSON.stringify(old));

    expect(repository().findOne("c")).toEqual(Result.succeed(old));
  });

  it("refuses a plan that is not JSON, or not a plan", () => {
    const { place, repository } = scratch();
    place("{");
    const broken = repository().findOne("c");

    expect(Result.isFailure(broken) && broken.failure.reason).toBe("not-json");

    place(JSON.stringify({ version: 3 }));
    const wrong = repository().findOne("c");

    expect(Result.isFailure(wrong) && wrong.failure.reason).toBe("undecodable");
  });
});
