import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { astGrepMatcher } from "@goodbones/ast-grep";
import {
  type CampaignRule,
  compileCampaignRules,
  EMPTY_BASELINE,
  EMPTY_GRAPH_RULES,
  EMPTY_STRUCTURE,
  evaluateCampaigns,
  formatMessage,
  ledgerOf,
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
// through `evaluateCampaigns` directly, must report the same hits — and a
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

const rules: ReadonlyArray<CampaignRule> = [
  {
    name: "campaign/react-class-components",
    id: "react-class-components",
    message: "Convert to a function component.",
    why: "Class lifecycle methods block concurrent features.",
    scope: "^parity/",
    unit: "declaration",
    detect: {
      syntax: {
        rule: { pattern: "class $NAME extends $BASE { $$$ }" },
        where: { BASE: { binding: { resolves: { external: "react" }, member: ["Component"] } } },
      },
    },
    probes: { fires: [], ignores: [] },
    staleAfter: 1,
    onComplete: "keep",
  },
  {
    name: "campaign/no-throw",
    id: "no-throw",
    message: "Return a Result.",
    why: "Errors are values.",
    scope: "^parity/",
    unit: "match",
    detect: { syntax: { rule: { pattern: "throw new Error($$$)" } } },
    probes: { fires: [], ignores: [] },
    staleAfter: 1,
    onComplete: "keep",
  },
  {
    name: "campaign/hooks-in-views",
    id: "hooks-in-views",
    message: "Move state out of the view.",
    why: "Views render.",
    scope: "^parity/",
    unit: "file",
    detect: {
      all: [
        { imports: { resolves: { external: "react" } } },
        { members: { subject: "calls", name: "^use[A-Z]" } },
      ],
    },
    probes: { fires: [], ignores: [] },
    staleAfter: 1,
    onComplete: "keep",
  },
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

const policyWith = (ledgers: LoadedPolicy["ledgers"]): LoadedPolicy => ({
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
  ledgers,
  ledgerDir: ".architecture-campaigns",
  functions: new Map(),
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
const hits = evaluateCampaigns(compiled.success, {
  file: FIXTURE.file,
  text: FIXTURE.code,
  facts: factsOfText(FIXTURE.file, FIXTURE.code),
  resolver,
  fileSystem: makeFileSystemFake([]),
  syntax: matcher.parse(FIXTURE.file, FIXTURE.code),
  functions: new Map(),
});

describe("the evaluator's own answer", () => {
  it("is what the fixture was written to yield", () => {
    expect(hits.map((hit) => `${hit.violation.ruleName}|${hit.violation.subject ?? ""}`)).toEqual([
      "campaign/react-class-components|Old",
      expect.stringMatching(/^campaign\/no-throw\|#[0-9a-f]{8}$/),
      expect.stringMatching(/^campaign\/no-throw\|helper#[0-9a-f]{8}$/),
      "campaign/hooks-in-views|",
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
const ledgered = new Map(
  rules.map((rule) => [
    rule.id,
    ledgerOf(
      rule.id,
      hits.filter((hit) => hit.campaign === rule.id).map((hit) => hit.violation),
      0,
    ),
  ]),
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
partial.set("react-class-components", ledgerOf("react-class-components", [], 0));
new RuleTester({ cwd: repoRoot }).run(
  "campaigns parity: one unledgered",
  makeCampaignsRule(policyWith(partial)),
  {
    valid: [],
    invalid: [
      {
        code: FIXTURE.code,
        filename,
        errors: [{ message: "[campaign/react-class-components] Convert to a function component." }],
      },
    ],
  },
);
