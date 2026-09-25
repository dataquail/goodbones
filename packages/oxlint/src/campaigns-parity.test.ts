import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { astGrepMatcher } from "@goodbones/ast-grep";
import {
  type CampaignPolicy,
  type CampaignRule,
  CAMPAIGNS_EXTENSION_ID,
  clearedSector,
  compileCampaignRules,
  EMPTY_LEDGER,
  evaluateObjectives,
  IMPLICIT_SECTOR,
  type Ledger,
  ledgerKeyOf,
  NO_REPORTS,
  sectorEntryOf,
} from "@goodbones/campaigns";
import {
  EMPTY_BASELINE,
  EMPTY_GRAPH_RULES,
  EMPTY_STRUCTURE,
  formatMessage,
  type LoadedPolicy,
  makeBaselineFilter,
} from "@goodbones/core";
import { makeFactExtractorFake, makeFileSystemFake } from "@goodbones/core/testing";
import { factsOfText } from "@goodbones/typescript";
import * as Result from "effect/Result";
import { RuleTester } from "oxlint/plugins-dev";
import { describe, expect, it } from "vitest";

import { makeCampaignsRule } from "./campaigns-rule.js";

RuleTester.describe = describe;
RuleTester.it = it;

// The campaigns family's parity contract is "one engine": the plugin parses
// `sourceCode.text` with the same matcher the CLI uses, and reads the facts
// through the same reader. So the same fixture, run through the rule and
// through `evaluateObjectives` directly, must report the same hits — and a
// ledgered hit must be silent in both.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const FIXTURE = {
  file: "parity/campaigns.tsx",
  code: `
import { Component, useState } from "react";
import Vendor from "vendor";
export class Old extends Component { render() { return null; } }
export class Widget extends Vendor.Widget {}
export class Plain extends Base {}
export const View = () => { const [n] = useState(0); return n; };
export function helper() { throw new Error("boom"); }
throw new Error("top level");
`,
};

// Three campaigns of the minimal shape: one objective each, the scope as
// the one sector.
const objective = (
  campaign: string,
  id: string,
  message: string,
  holdout: "file" | "declaration" | "match",
  match: CampaignRule["objectives"][number]["match"],
): CampaignRule => ({
  name: `campaign/${campaign}`,
  id: campaign,
  scope: "^parity/",
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
  objective(
    "react-class-components",
    "class-shape",
    "Convert to a function component.",
    "declaration",
    {
      syntax: {
        rule: { pattern: "class $NAME extends $BASE { $$$ }" },
        where: { BASE: { binding: { resolves: { external: "react" }, member: ["Component"] } } },
      },
    },
  ),
  objective("no-throw", "throws", "Return a Result.", "match", {
    syntax: { rule: { pattern: "throw new Error($$$)" } },
  }),
  objective("hooks-in-views", "hooks", "Move state out of the view.", "file", {
    all: [
      { imports: { resolves: { external: "react" } } },
      { members: { subject: "calls", name: "^use[A-Z]" } },
    ],
  }),
];

const compiled = compileCampaignRules(rules);
if (Result.isFailure(compiled)) throw compiled.failure;

const resolver = {
  resolve: (_from: string, specifier: string) =>
    specifier === "react"
      ? Result.succeed({
          path: "node_modules/react/index.js",
          kind: "external" as const,
          package: "react",
        })
      : specifier === "vendor"
        ? Result.succeed({
            path: "node_modules/vendor/index.js",
            kind: "external" as const,
            package: "vendor",
          })
        : Result.fail(new Error("unresolved") as never),
};

const matcher = astGrepMatcher();

const policyWith = (ledgers: CampaignPolicy["ledgers"]): LoadedPolicy => ({
  repoRoot,
  config: { resolve: { scopes: [{ files: "", language: "typescript" }] }, tree: {} },
  importRules: [],
  exportRules: [],
  memberRules: [],
  surfaceRules: [],
  graph: EMPTY_GRAPH_RULES,
  adoption: { unrestricted: [], partial: [] },
  structure: EMPTY_STRUCTURE,
  extensions: new Map<string, unknown>([
    [
      CAMPAIGNS_EXTENSION_ID,
      {
        campaignRules: compiled.success,
        ledgers,
        measureLedgers: new Map(),
        legacyLedgers: new Map(),
        sectorRecords: new Map(),
        plans: new Map(),
        ledgerDir: ".architecture-campaigns",
        functions: new Map(),
        reports: NO_REPORTS,
      } satisfies CampaignPolicy,
    ],
  ]),
  routeFor: () => undefined,
  now: 0,
  syntax: matcher,
  fileSystem: makeFileSystemFake([]),
  languages: [],
  extractor: makeFactExtractorFake({}),
  resolver,
  ignoreUnresolved: [],
  notices: [],
  baseline: makeBaselineFilter(EMPTY_BASELINE),
});

// The CLI's answer: the same fixture through the evaluator directly.
const hits = evaluateObjectives(
  compiled.success.flatMap((rule) => rule.objectives),
  {
    file: FIXTURE.file,
    text: FIXTURE.code,
    facts: factsOfText(FIXTURE.file, FIXTURE.code),
    resolver,
    fileSystem: makeFileSystemFake([]),
    syntax: matcher.parse(FIXTURE.file, FIXTURE.code),
    functions: new Map(),
    reports: NO_REPORTS,
  },
);

describe("the evaluator's own answer", () => {
  it("is what the fixture was written to yield", () => {
    expect(hits.map((hit) => `${hit.violation.ruleName}|${hit.violation.subject ?? ""}`)).toEqual([
      "campaign/react-class-components/class-shape|Old",
      expect.stringMatching(/^campaign\/no-throw\/throws\|#[0-9a-f]{8}$/),
      expect.stringMatching(/^campaign\/no-throw\/throws\|helper#[0-9a-f]{8}$/),
      "campaign/hooks-in-views/hooks|",
    ]);
  });
});

const filename = path.join(repoRoot, FIXTURE.file);

new RuleTester({ cwd: repoRoot }).run(
  "campaigns parity: every hit",
  makeCampaignsRule(policyWith(new Map())),
  {
    valid: [{ code: "export const quiet = 1;", filename }],
    invalid: [
      {
        code: FIXTURE.code,
        filename,
        // oxlint reports in position order; a file-unit hit sits on line 1.
        errors: [...hits]
          .sort((left, right) => {
            const at = (hit: (typeof hits)[number]) => hit.range?.start ?? { line: 0, column: 0 };
            const byLine = at(left).line - at(right).line;
            return byLine === 0 ? at(left).column - at(right).column : byLine;
          })
          .map((hit) => ({ message: formatMessage(hit.violation) })),
      },
    ],
  },
);

// With every hit in its ledger, both hosts are silent; with the class
// component's entry missing, both report exactly that one.
const ledgerFor = (rule: CampaignRule, entries: ReadonlyArray<string>): [string, Ledger] => {
  const [one] = rule.objectives;
  if (one === undefined) throw new Error("no objective");
  return [
    ledgerKeyOf(rule.id, one.id),
    clearedSector(
      EMPTY_LEDGER(rule.id, one.id, 0),
      IMPLICIT_SECTOR,
      entries,
      one.holdout === "sector" || one.holdout === undefined ? "file" : one.holdout,
      0,
      "inside",
    ),
  ];
};
const ledgered = new Map(
  rules.map((rule) =>
    ledgerFor(
      rule,
      hits.filter((hit) => hit.campaign === rule.id).map((hit) => sectorEntryOf(hit.violation, "")),
    ),
  ),
);
new RuleTester({ cwd: repoRoot }).run(
  "campaigns parity: ledgered",
  makeCampaignsRule(policyWith(ledgered)),
  {
    valid: [{ code: FIXTURE.code, filename }],
    invalid: [],
  },
);

const partial = new Map(ledgered);
const [reactRule] = rules;
if (reactRule === undefined) throw new Error("no rule");
partial.set(...ledgerFor(reactRule, []));
new RuleTester({ cwd: repoRoot }).run(
  "campaigns parity: one unledgered",
  makeCampaignsRule(policyWith(partial)),
  {
    valid: [],
    invalid: [
      {
        code: FIXTURE.code,
        filename,
        errors: [
          {
            message:
              "[campaign/react-class-components/class-shape] Convert to a function component.",
          },
        ],
      },
    ],
  },
);
