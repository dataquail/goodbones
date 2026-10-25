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
import { attestSectorUseCase } from "./attest-sector.use-case.js";
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
