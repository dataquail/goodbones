import { type Language, loadPolicy } from "@goodbones/core";
import {
  makeFactExtractorFake,
  makeFileSystemFake,
  makeModuleResolverFake,
} from "@goodbones/core/testing";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import { campaignsExtension, type CampaignsExtensionOptions } from "../../../load/extension.js";
import { makeGitClientFake } from "../infrastructure/clients/git.client-fake.js";
import { makeObjectiveLedgersRepositoryFake } from "../infrastructure/repositories/objective-ledgers.repository-fake.js";
import { makePlansRepositoryFake } from "../infrastructure/repositories/plans.repository-fake.js";
import { makeSectorRecordsRepositoryFake } from "../infrastructure/repositories/sector-records.repository-fake.js";
import { clearObjectivesUseCase } from "./clear-objectives.use-case.js";
import { evaluateCampaignsUseCase } from "./evaluate-campaigns.use-case.js";

// One campaign over two sectors: `src/a` holds a TODO and stands at the
// first phase; `src/b` holds none and stands at the attested one.
const fake: Language = {
  id: "fake",
  extensions: [".ts"],
  ignoredFiles: [],
  packageMarkers: [],
  sourceRoots: [],
  extractor: makeFactExtractorFake({}),
  fixes: [],
  makeResolver: () => Result.succeed(makeModuleResolverFake({})),
};

const TODO = { "src/a/x.ts": "// TODO\n", "src/a/y.ts": "done\n", "src/b/z.ts": "done\n" };
const CLEAN = { ...TODO, "src/a/x.ts": "done\n" };

const MANIFEST = {
  resolve: { scopes: [{ files: "^src/", language: "fake" }] },
  tree: { "src/": { layout: "open", children: {} } },
  campaigns: {
    tidy: {
      why: "No TODOs.",
      scope: ["src/**"],
      perimeter: { glob: ["src/*/"] },
      phases: [
        { id: "swept", objectives: ["no-todo"] },
        { id: "signed", attested: true, intent: "Read by hand." },
        { id: "trimmed", objectives: ["lines"] },
      ],
      objectives: {
        "no-todo": {
          holdout: "file",
          match: { content: { regex: "TODO" } },
          probes: { fires: [{ path: "src/a/x.ts", source: "// TODO" }] },
        },
        lines: { measure: { lines: true }, direction: "down", target: 1 },
      },
    },
  },
};

const fakes = () => ({
  repositories: {
    ledgers: makeObjectiveLedgersRepositoryFake(),
    sectorRecords: makeSectorRecordsRepositoryFake(),
    plans: makePlansRepositoryFake(),
  },
  git: makeGitClientFake({ refs: { HEAD: {} } }),
});

type Fakes = ReturnType<typeof fakes> & Pick<CampaignsExtensionOptions, "baseSides">;

// The policy loaded over `sources`, reading and saving its ledgers through
// `with`'s repositories, and its campaign evaluated.
const load = (sources: Readonly<Record<string, string>>, with_: Fakes = fakes(), now = 1e12) => {
  const loaded = loadPolicy({
    repoRoot: "/repo",
    configPath: "/repo/architecture.json",
    manifest: MANIFEST,
    languages: [fake],
    fileSystem: makeFileSystemFake([], sources),
    now,
    extensions: [campaignsExtension(with_)],
  });

  if (Result.isFailure(loaded)) throw loaded.failure;
  const policy = loaded.success;
  const [evaluation] = evaluateCampaignsUseCase(policy, ["src"], Object.keys(sources));

  if (evaluation === undefined) throw new Error("no campaign evaluated");

  return { ...with_, policy, evaluation };
};

describe("clearObjectivesUseCase", () => {
  it("records each sector entering a window, the phase it reached, and the plan", () => {
    const { evaluation, policy, repositories } = load(TODO);
    const outcomes = clearObjectivesUseCase(policy, evaluation, null, "a@example.com");

    expect(outcomes.find((one) => one.objective === "no-todo")).toMatchObject({
      entered: ["src/a", "src/b"],
      left: 1,
    });
    expect(repositories.ledgers.stored.get("tidy/no-todo")).toMatchObject({
      sectors: { "src/a": { holdouts: ["x.ts"] }, "src/b": { holdouts: [] } },
    });
    expect(repositories.sectorRecords.stored.get("tidy/src/b")?.reached).toBe("signed");
    expect(repositories.plans.stored.has("tidy")).toBe(true);
  });

  it("clears what was fixed since, and with one objective named writes no record or plan", () => {
    const first = load(TODO);
    clearObjectivesUseCase(first.policy, first.evaluation, null, "a@example.com");
    const plan = first.repositories.plans.stored.get("tidy");

    const { evaluation, policy, repositories } = load(CLEAN, first);
    const [outcome] = clearObjectivesUseCase(policy, evaluation, "no-todo", "a@example.com");

    expect(outcome).toMatchObject({ objective: "no-todo", cleared: 1, left: 0 });
    expect(repositories.plans.stored.get("tidy")).toBe(plan);
  });
});
