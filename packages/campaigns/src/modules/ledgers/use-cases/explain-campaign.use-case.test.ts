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
import { evaluateCampaignsUseCase } from "./evaluate-campaigns.use-case.js";
import { explainCampaignUseCase } from "./explain-campaign.use-case.js";

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

describe("explainCampaignUseCase", () => {
  it("names the file's sector, its phase, and the objectives that fire on it", () => {
    const { evaluation, policy } = load(TODO);

    expect(explainCampaignUseCase(policy, evaluation, "src/a/x.ts")).toMatchObject({
      campaign: { id: "tidy", phases: 3 },
      sector: "src/a",
      shared: false,
      index: 0,
      phase: { id: "swept", open: false, attested: false, intent: null },
      inWindow: [{ id: "no-todo", firing: true }],
      measures: [],
    });
  });

  it("answers nothing for a file in no sector", () => {
    const { evaluation, policy } = load(TODO);

    expect(explainCampaignUseCase(policy, evaluation, "lib/x.ts")).toBeNull();
  });
});
