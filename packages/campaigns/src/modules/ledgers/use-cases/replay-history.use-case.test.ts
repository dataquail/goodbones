import { type Language, loadPolicy } from "@goodbones/core";
import {
  makeFactExtractorFake,
  makeFileSystemFake,
  makeModuleResolverFake,
} from "@goodbones/core/testing";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import { campaignsOf } from "../../../load/campaign-policy.js";
import { campaignsExtension, type CampaignsExtensionOptions } from "../../../load/extension.js";
import { makeGitClientFake } from "../infrastructure/clients/git.client-fake.js";
import { makeObjectiveLedgersRepositoryFake } from "../infrastructure/repositories/objective-ledgers.repository-fake.js";
import { makePlansRepositoryFake } from "../infrastructure/repositories/plans.repository-fake.js";
import { makeSectorRecordsRepositoryFake } from "../infrastructure/repositories/sector-records.repository-fake.js";
import { evaluateCampaignsUseCase } from "./evaluate-campaigns.use-case.js";
import { replayHistoryUseCase } from "./replay-history.use-case.js";

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

describe("replayHistoryUseCase", () => {
  it("replays each commit that touched the ledgers or the manifest, through git", () => {
    const ledger = (holdouts: ReadonlyArray<string>) =>
      JSON.stringify({ sectors: { "src/a": { holdouts } } });

    const at = ".architecture-campaigns/tidy/no-todo.json";

    const git = makeGitClientFake({
      refs: { one: { [at]: ledger(["x.ts", "y.ts"]) }, two: { [at]: ledger(["x.ts"]) } },
      commits: [
        { sha: "one", at: "2026-10-01T00:00:00Z", subject: "first", files: [at] },
        { sha: "two", at: "2026-10-02T00:00:00Z", subject: "second", files: [at, "arch.yaml"] },
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
    ]);
  });
});
