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
import { concedeObjectiveUseCase } from "./concede-objective.use-case.js";
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

const receipt = { at: 1e12, by: "a@example.com", reason: "Needed for the release." };

describe("concedeObjectiveUseCase", () => {
  it("refuses an objective with no ledger yet", () => {
    const { evaluation, policy } = load(TODO);

    expect(
      Result.isFailure(concedeObjectiveUseCase(policy, evaluation, "no-todo", null, null, receipt)),
    ).toBe(true);
  });

  it("joins the unrecorded hits to the ledger, with the reason and the author", () => {
    const first = load(CLEAN);
    clearObjectivesUseCase(first.policy, first.evaluation, null, "a@example.com");
    const { evaluation, policy, repositories } = load(TODO, first);
    const done = concedeObjectiveUseCase(policy, evaluation, "no-todo", null, null, receipt);

    expect(done).toEqual(
      Result.succeed({
        objective: "no-todo",
        conceded: [{ sector: "src/a", entry: "x.ts" }],
        left: [],
        sentBack: [{ sector: "src/a", from: "signed", to: "swept", revoked: [] }],
      }),
    );
    expect(repositories.ledgers.stored.get("tidy/no-todo")).toMatchObject({
      sectors: { "src/a": { holdouts: ["x.ts"] } },
    });
  });

  it("refuses a holdout that is not an unrecorded hit, and a choice among a scalar's", () => {
    const first = load(CLEAN);
    clearObjectivesUseCase(first.policy, first.evaluation, null, "a@example.com");
    const { evaluation, policy } = load(TODO, first);

    expect(
      Result.isFailure(
        concedeObjectiveUseCase(policy, evaluation, "no-todo", ["y.ts"], null, receipt),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(concedeObjectiveUseCase(policy, evaluation, "lines", ["x"], null, receipt)),
    ).toBe(true);
  });
});
