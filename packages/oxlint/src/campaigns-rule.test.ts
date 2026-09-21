import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { astGrepMatcher } from "@goodbones/ast-grep";
import {
  type CampaignRule,
  compileCampaignRules,
  EMPTY_BASELINE,
  EMPTY_GRAPH_RULES,
  EMPTY_STRUCTURE,
  type LoadedPolicy,
  makeBaselineFilter,
  type ReportSource,
  ReportUnavailable,
} from "@goodbones/core";
import {
  makeFactExtractorFake,
  makeFileSystemFake,
  makeModuleResolverFake,
} from "@goodbones/core/testing";
import * as Result from "effect/Result";
import { RuleTester } from "oxlint/plugins-dev";
import { describe, expect, it } from "vitest";

import { makeCampaignsRule } from "./campaigns-rule.js";

// The cases are one lint run in order — the notice lands on the first
// file, and the count is read after the last — so this file opts out of the
// shared config's concurrent sequence.
RuleTester.describe = describe.sequential;
RuleTester.it = it.sequential;

// A `report` term whose source cannot be read is one fact about the lint
// run. The rule says it once, on the first file a campaign naming that
// report selects, and keeps judging every other campaign on that file and
// every file after it — rather than throwing out of the visitor on each
// file, which oxlint renders as a generic per-file plugin error with the
// cause dropped.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const objective = (
  campaign: string,
  id: string,
  message: string,
  holdout: "file" | "match",
  match: CampaignRule["objectives"][number]["match"],
): CampaignRule => ({
  name: `campaign/${campaign}`,
  id: campaign,
  scope: "^unreachable/",
  extensions: [],
  phases: [],
  objectives: [
    {
      name: `campaign/${campaign}/${id}`,
      id,
      campaign,
      message,
      holdout,
      ...(match === undefined ? {} : { match }),
      probes: { fires: [], ignores: [] },
    },
  ],
  onComplete: "keep",
});

const rules: ReadonlyArray<CampaignRule> = [
  objective("tsc-clean", "tsc", "Fix the type error.", "match", {
    report: { command: ["tsc --noEmit"], format: "tsc" },
  }),
  objective("no-todo", "todo", "Resolve the TODO.", "file", { content: { regex: "TODO" } }),
];

const compiled = compileCampaignRules(rules);
if (Result.isFailure(compiled)) throw compiled.failure;

// The live source's answer once a spawn was refused: the kept failure, on
// every ask. Counted, to show the rule asks no more than the source needs.
let asked = 0;
const refused: ReportSource = {
  diagnosticsOf: () => {
    asked += 1;
    throw new ReportUnavailable({
      kind: "command",
      source: "tsc --noEmit",
      detail: "spawnSync /bin/sh ENOMEM",
    });
  },
};

const policy: LoadedPolicy = {
  repoRoot,
  config: { resolve: { scopes: [{ files: "", language: "typescript" }] }, tree: {} },
  importRules: [],
  exportRules: [],
  memberRules: [],
  surfaceRules: [],
  graph: EMPTY_GRAPH_RULES,
  adoption: { unrestricted: [], partial: [] },
  structure: EMPTY_STRUCTURE,
  campaignRules: compiled.success,
  ledgers: new Map(),
  legacyLedgers: new Map(),
  sectorRecords: new Map(),
  plans: new Map(),
  ledgerDir: ".architecture-campaigns",
  functions: new Map(),
  now: 0,
  syntax: astGrepMatcher(),
  reports: refused,
  fileSystem: makeFileSystemFake([]),
  languages: [],
  extractor: makeFactExtractorFake({}),
  resolver: makeModuleResolverFake({}),
  ignoreUnresolved: [],
  notices: [],
  baseline: makeBaselineFilter(EMPTY_BASELINE),
};

// One rule instance across both runs, as one oxlint process holds one.
const rule = makeCampaignsRule(policy);
const under = (file: string) => path.join(repoRoot, "unreachable", file);

new RuleTester({ cwd: repoRoot }).run("campaigns: a report that cannot be read", rule, {
  valid: [],
  invalid: [
    {
      // The first file: the notice, once, and the other campaign's hit.
      code: "// TODO: later\nexport const a = 1;",
      filename: under("first.ts"),
      errors: [
        {
          message:
            /^A report a campaign names could not be read.*`tsc --noEmit` could not be run: spawnSync \/bin\/sh ENOMEM\..*named by `file:`/s,
        },
        { message: "[campaign/no-todo/todo] Resolve the TODO." },
      ],
    },
  ],
});

new RuleTester({ cwd: repoRoot }).run("campaigns: the same failure, on the next file", rule, {
  valid: [
    // The second file: nothing about the report, though it asked again.
    { code: "export const b = 2;", filename: under("second.ts") },
  ],
  invalid: [
    {
      code: "// TODO: still\nexport const c = 3;",
      filename: under("third.ts"),
      errors: [{ message: "[campaign/no-todo/todo] Resolve the TODO." }],
    },
  ],
});

describe.sequential("what the rule asked of the source", () => {
  it.sequential("asked once per selected file, and said the failure once", () => {
    expect(asked).toBe(3);
  });
});
