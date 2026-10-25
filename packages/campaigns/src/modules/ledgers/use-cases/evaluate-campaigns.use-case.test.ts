import { type Language, loadPolicy } from "@goodbones/core";
import {
  makeFactExtractorFake,
  makeFileSystemFake,
  makeModuleResolverFake,
} from "@goodbones/core/testing";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import { campaignsExtension } from "../../../load/extension.js";
import { makeMeasureCommandsClientFake } from "../infrastructure/clients/measure-commands.client-fake.js";
import { evaluateCampaignsUseCase } from "./evaluate-campaigns.use-case.js";

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

const files = { "src/a/x.ts": "// TODO\n", "src/a/y.ts": "done\n", "src/b/z.ts": "done\n" };

const load = (commands = makeMeasureCommandsClientFake({ "count-it": "7\n" })) => {
  const loaded = loadPolicy({
    repoRoot: "/repo",
    configPath: "/repo/architecture.json",
    manifest: {
      resolve: { scopes: [{ files: "^src/", language: "fake" }] },
      tree: { "src/": { layout: "open", children: {} } },
      campaigns: {
        tidy: {
          why: "No TODOs.",
          scope: ["src/**"],
          perimeter: { glob: ["src/*/"] },
          objectives: {
            "no-todo": {
              holdout: "file",
              match: { content: { regex: "TODO" } },
              probes: { fires: [{ path: "src/a/x.ts", source: "// TODO" }] },
            },
          },
        },
        counted: {
          why: "Fewer of them.",
          scope: ["src/**"],
          objectives: { count: { measure: { command: "count-it" }, direction: "down" } },
        },
      },
    },
    languages: [fake],
    fileSystem: makeFileSystemFake([], files),
    extensions: [campaignsExtension({ commands })],
  });

  if (Result.isFailure(loaded)) throw loaded.failure;

  return { policy: loaded.success, commands };
};

describe("evaluateCampaignsUseCase", () => {
  it("evaluates every campaign over the files, read through the policy's file system", () => {
    const { policy } = load();
    const [evaluation] = evaluateCampaignsUseCase(policy, ["src"], Object.keys(files));

    expect([...(evaluation?.sectors.keys() ?? [])].sort()).toEqual(["src/a", "src/b"]);
    expect(evaluation?.sectors.get("src/a")?.counts["no-todo"]).toBe(1);
    expect(evaluation?.sectors.get("src/b")?.counts["no-todo"]).toBe(0);
  });

  it("runs a `command` measure through the policy's client, once per evaluation", () => {
    const { commands, policy } = load();
    const [, evaluation] = evaluateCampaignsUseCase(policy, ["src"], Object.keys(files));

    expect(evaluation?.sectors.get("scope")?.values.count).toBe(7);
    expect(commands.asked).toEqual(["count-it"]);
  });

  it("measures no number for a command that could not be spawned", () => {
    const { policy } = load(makeMeasureCommandsClientFake());
    const [, evaluation] = evaluateCampaignsUseCase(policy, ["src"], Object.keys(files));

    expect(evaluation?.sectors.get("scope")?.values.count).toBeNaN();
  });
});
