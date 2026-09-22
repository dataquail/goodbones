import { fingerprintOf, type SourceFacts } from "@goodbones/core";
import {
  makeFactExtractorFake,
  makeFileSystemFake,
  makeModuleResolverFake,
  makeSyntaxMatcherFake,
  type StagedMatch,
} from "@goodbones/core/testing";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { CampaignRule, Detector, ObjectiveRule } from "../domain/config.js";
import { makeReportSourceFake } from "../infrastructure/report-source-fake.js";
import {
  type CampaignInput,
  type CampaignPredicate,
  campaignsFailingTheirProbe,
  campaignsSelecting,
  compileCampaignRule,
  type CompiledCampaign,
  type CompiledObjective,
  compileObjective,
  evaluateObjective,
  explainObjective,
  matchKeyOf,
} from "./campaigns.js";

const NOTHING: SourceFacts = {
  specifiers: [],
  bindings: new Map(),
  memberSites: [],
  exportSites: [],
};

// One objective, compiled on its own: what the evaluator reads a file with.
const rule = (
  detect: Detector,
  unit: ObjectiveRule["holdout"] = "file",
  overrides: Partial<ObjectiveRule> = {},
): CompiledObjective => {
  const compiled = compileObjective({
    name: "campaign/x/o",
    id: "o",
    campaign: "x",
    message: "Migrate it.",
    why: "Because.",
    holdout: unit,
    match: detect,
    probes: { fires: [], ignores: [] },
    ...overrides,
  });
  if (Result.isFailure(compiled)) throw compiled.failure;
  return compiled.success;
};

// The campaign around an objective, as the probe check and the selection
// take one: the objective's scope is its campaign's.
const campaignOf = (
  objectives: ReadonlyArray<CompiledObjective>,
  overrides: Partial<CampaignRule> = {},
): CompiledCampaign => {
  const compiled = compileCampaignRule({
    name: "campaign/x",
    id: "x",
    scope: "^src/",
    extensions: [],
    phases: [],
    objectives: [],
    onComplete: "keep",
    ...overrides,
  });
  if (Result.isFailure(compiled)) throw compiled.failure;
  return { ...compiled.success, objectives };
};

// One file, staged: its facts, its text, what its syntax yields for any
// rule, what its edges resolve to, and which siblings exist.
const input = (
  overrides: Partial<CampaignInput> & {
    readonly matches?: ReadonlyArray<StagedMatch>;
    readonly edges?: Readonly<Record<string, string>>;
    readonly siblings?: ReadonlyArray<string>;
    readonly diagnostics?: Parameters<typeof makeReportSourceFake>[0][string];
  } = {},
): CampaignInput => {
  const text = overrides.text ?? "source";
  return {
    file: "src/a.ts",
    text,
    facts: NOTHING,
    resolver: makeModuleResolverFake(overrides.edges ?? {}),
    fileSystem: makeFileSystemFake(overrides.siblings ?? []),
    syntax: makeSyntaxMatcherFake({ [text]: overrides.matches ?? [] }).parse("src/a.ts", text),
    functions: new Map(),
    reports: makeReportSourceFake({ [overrides.file ?? "src/a.ts"]: overrides.diagnostics ?? [] }),
    ...overrides,
  };
};

const subjects = (rule: CompiledObjective, at: CampaignInput): ReadonlyArray<string | null> =>
  evaluateObjective(rule, at).map((hit) => hit.violation.subject);

const fires = (rule: CompiledObjective, at: CampaignInput): boolean =>
  evaluateObjective(rule, at).length > 0;

describe("every leaf term, true and false", () => {
  it("path: the file's path, with an optional naming convention on a capture", () => {
    expect(fires(rule({ path: { file: "\\.ts$" } }), input())).toBe(true);
    expect(fires(rule({ path: { file: "\\.js$" } }), input())).toBe(false);
    expect(fires(rule({ path: { file: "\\.ts$", fileNot: "^src/a" } }), input())).toBe(false);
    const snake = rule({
      path: { file: "^src/([^/]+)\\.ts$", subject: 1, convention: "^[a-z0-9]+(?:_[a-z0-9]+)*$" },
    });
    expect(fires(snake, input({ file: "src/old_name.ts" }))).toBe(true);
    expect(fires(snake, input({ file: "src/newName.ts" }))).toBe(false);
  });

  it("imports: an edge resolving to the target, optionally carrying a symbol", () => {
    const facts: SourceFacts = {
      ...NOTHING,
      specifiers: ["react", "./x"],
      bindings: new Map([
        ["react", [{ symbol: "Component", kind: "named", local: "Component" }]],
        ["./x", [{ symbol: "x", kind: "named", local: "x" }]],
      ]),
    };
    const edges = { react: "node_modules/react/index.js", "./x": "src/x.ts" };
    expect(
      fires(rule({ imports: { resolves: { external: "react" } } }), input({ facts, edges })),
    ).toBe(true);
    expect(
      fires(rule({ imports: { resolves: { external: "vue" } } }), input({ facts, edges })),
    ).toBe(false);
    expect(fires(rule({ imports: { resolves: "^src/x" } }), input({ facts, edges }))).toBe(true);
    expect(
      fires(
        rule({ imports: { resolves: { external: "react" }, symbols: ["Component"] } }),
        input({ facts, edges }),
      ),
    ).toBe(true);
    expect(
      fires(
        rule({ imports: { resolves: { external: "react" }, symbols: ["useState"] } }),
        input({ facts, edges }),
      ),
    ).toBe(false);
    // An unresolved edge is no edge.
    expect(fires(rule({ imports: { resolves: "." } }), input({ facts, edges: {} }))).toBe(false);
  });

  it("exports: an export site the selectors admit", () => {
    const facts: SourceFacts = {
      ...NOTHING,
      exportSites: [
        { file: "src/a.ts", name: "Foo", kind: "named", declares: "class", reexport: false },
        {
          file: "src/a.ts",
          name: "default",
          kind: "default",
          declares: "function",
          reexport: false,
        },
      ],
    };
    expect(fires(rule({ exports: { declares: ["class"] } }), input({ facts }))).toBe(true);
    expect(fires(rule({ exports: { kinds: ["namespace"] } }), input({ facts }))).toBe(false);
    expect(fires(rule({ exports: { name: "^Fo" } }), input({ facts }))).toBe(true);
    expect(fires(rule({ exports: { reexport: true } }), input({ facts }))).toBe(false);
  });

  it("members: a member or called name the selectors admit", () => {
    const facts: SourceFacts = {
      ...NOTHING,
      memberSites: [
        { file: "src/a.ts", subject: "members", name: "run", in: "Port", declares: "interface" },
        { file: "src/a.ts", subject: "calls", name: "useState" },
      ],
    };
    expect(fires(rule({ members: { subject: "calls", name: "^use" } }), input({ facts }))).toBe(
      true,
    );
    expect(fires(rule({ members: { subject: "calls", name: "^set" } }), input({ facts }))).toBe(
      false,
    );
    expect(
      fires(
        rule({ members: { subject: "members", in: "^Port$", declares: ["interface"] } }),
        input({ facts }),
      ),
    ).toBe(true);
    expect(
      fires(rule({ members: { subject: "members", declares: ["class"] } }), input({ facts })),
    ).toBe(false);
  });

  it("requires: every named sibling exists", () => {
    const term = rule({ requires: ["{base}.test.ts"] });
    expect(fires(term, input({ siblings: ["src/a.test.ts"] }))).toBe(true);
    expect(fires(term, input({ siblings: [] }))).toBe(false);
  });

  it("content: a multiline regex over the text", () => {
    expect(
      fires(rule({ content: { regex: "^'use client'" } }), input({ text: "x\n'use client'" })),
    ).toBe(true);
    expect(
      fires(rule({ content: { regex: "^'use client'" } }), input({ text: "x 'use client'" })),
    ).toBe(false);
  });

  it("syntax: a match the matcher yields, narrowed by capture", () => {
    const matches: ReadonlyArray<StagedMatch> = [
      { text: "useState()", captures: { HOOK: "useState" }, anchor: "Bar" },
      { text: "usage()", captures: { HOOK: "usage" }, anchor: "Bar" },
    ];
    expect(fires(rule({ syntax: { rule: { pattern: "$HOOK($$$)" } } }), input({ matches }))).toBe(
      true,
    );
    expect(
      subjects(
        rule(
          { syntax: { rule: { pattern: "$HOOK($$$)" }, where: { HOOK: { regex: "^use[A-Z]" } } } },
          "match",
        ),
        input({ matches }),
      ),
    ).toEqual([matchKeyOf("Bar", "useState()")]);
    expect(
      fires(
        rule({ syntax: { rule: { pattern: "$X" }, where: { HOOK: { regex: "^zz" } } } }),
        input({ matches }),
      ),
    ).toBe(false);
    // No matcher for the file's language: nothing matches.
    expect(
      fires(rule({ syntax: { rule: { pattern: "$X" } } }), input({ matches, syntax: null })),
    ).toBe(false);
  });

  it("report: each diagnostic another tool reported on the file, anchored on the declaration at its position", () => {
    const diagnostics = [
      { line: 3, column: 4, code: "TS2551", message: "Property 'x' does not exist" },
      { line: 3, column: 9, code: "TS2551", message: "Property 'x' does not exist" },
      { line: 7, column: 0, code: "TS18048", message: "'y' is possibly undefined" },
      { line: 9, column: 0, code: "", message: "unnamed" },
    ];
    // The staged matches are what `anchorAt` answers from: line 3 sits in
    // `parse`, line 7 in `format`, line 9 at the top level.
    const matches: ReadonlyArray<StagedMatch> = [
      { text: "parse", anchor: "parse", line: 3, rule: { kind: "never" } },
      { text: "format", anchor: "format", line: 7, rule: { kind: "never" } },
    ];
    const tsc = (unit: ObjectiveRule["holdout"], codes?: ReadonlyArray<string>) =>
      rule(
        {
          report: {
            command: ["tsc --noEmit"],
            format: "tsc",
            ...(codes === undefined ? {} : { codes }),
          },
        },
        unit,
      );
    expect(fires(tsc("file"), input({ diagnostics, matches }))).toBe(true);
    expect(fires(tsc("file"), input({ diagnostics: [], matches }))).toBe(false);
    expect(subjects(tsc("declaration"), input({ diagnostics, matches }))).toEqual([
      "format",
      "parse",
    ]);
    const keys = subjects(tsc("match"), input({ diagnostics, matches }));
    // Two identical diagnostics in one declaration are two entries; the
    // unnamed code has no code segment; the top-level one has no anchor.
    expect(keys).toEqual([
      expect.stringMatching(/^#[0-9a-f]{8}$/),
      expect.stringMatching(/^format#TS18048#[0-9a-f]{8}$/),
      expect.stringMatching(/^parse#TS2551#[0-9a-f]{8}$/),
      expect.stringMatching(/^parse#TS2551#[0-9a-f]{8}~2$/),
    ]);
    expect(subjects(tsc("match", ["TS18048"]), input({ diagnostics, matches }))).toEqual([
      expect.stringMatching(/^format#TS18048#/),
    ]);
    // The line moving leaves the key alone; the message changing does not.
    const moved = diagnostics.map((one) => ({ ...one, line: one.line + 20 }));
    const movedMatches = matches.map((one) => ({ ...one, line: (one.line ?? 0) + 20 }));
    expect(subjects(tsc("match"), input({ diagnostics: moved, matches: movedMatches }))).toEqual(
      keys,
    );
    const reworded = diagnostics.map((one) => ({ ...one, message: `${one.message}!` }));
    expect(subjects(tsc("match"), input({ diagnostics: reworded, matches }))).not.toEqual(keys);
    // Without a syntax tree there is no anchor, and the report still counts.
    expect(subjects(tsc("match"), input({ diagnostics, syntax: null }))).toHaveLength(4);
  });

  it("fn: a predicate's verdict, or the subjects it lists", () => {
    const functions = new Map<string, CampaignPredicate>([
      ["./p.mjs#yes", () => true],
      ["./p.mjs#no", () => false],
      ["./p.mjs#lists", () => [{ subject: "Widget" }, { subject: "Panel" }]],
    ]);
    expect(fires(rule({ fn: "./p.mjs#yes" }), input({ functions }))).toBe(true);
    expect(fires(rule({ fn: "./p.mjs#no" }), input({ functions }))).toBe(false);
    expect(subjects(rule({ fn: "./p.mjs#lists" }, "declaration"), input({ functions }))).toEqual([
      "Panel",
      "Widget",
    ]);
    // A function the loader did not hand over answers false.
    expect(fires(rule({ fn: "./p.mjs#absent" }), input({ functions }))).toBe(false);
  });
});

describe("the unit decides what a term from another level means", () => {
  const facts: SourceFacts = {
    ...NOTHING,
    specifiers: ["react"],
    bindings: new Map([["react", [{ symbol: "Component", kind: "named", local: "Component" }]]]),
    exportSites: [
      { file: "src/a.ts", name: "Foo", kind: "named", declares: "class", reexport: false },
      { file: "src/a.ts", name: "Bar", kind: "named", declares: "variable", reexport: false },
    ],
  };
  const matches: ReadonlyArray<StagedMatch> = [
    {
      text: "class Foo extends Component {}",
      captures: { NAME: "Foo" },
      anchor: "Foo",
      rule: { pattern: "class $NAME extends $B { $$$ }" },
    },
    { text: "useState()", anchor: "Bar", rule: { pattern: "$HOOK($$$)" } },
    { text: "useState()", anchor: null, rule: { pattern: "$HOOK($$$)" } },
  ];
  const edges = { react: "node_modules/react/index.js" };
  const classes: Detector = { syntax: { rule: { pattern: "class $NAME extends $B { $$$ }" } } };
  const hooks: Detector = { syntax: { rule: { pattern: "$HOOK($$$)" } } };
  const at = () => input({ facts, matches, edges });

  // file-level term × each unit
  it("a file-level term is the answer in a file campaign, a filter elsewhere", () => {
    const imports: Detector = { imports: { resolves: { external: "react" } } };
    expect(subjects(rule(imports, "file"), at())).toEqual([null]);
    // A filter alone sources no candidate.
    expect(subjects(rule(imports, "declaration"), at())).toEqual([]);
    expect(subjects(rule(imports, "match"), at())).toEqual([]);
    expect(subjects(rule({ all: [imports, { exports: {} }] }, "declaration"), at())).toEqual([
      "Bar",
      "Foo",
    ]);
    expect(
      subjects(
        rule(
          { all: [{ imports: { resolves: { external: "vue" } } }, { exports: {} }] },
          "declaration",
        ),
        at(),
      ),
    ).toEqual([]);
  });

  // declaration-level term × each unit
  it("a declaration-level term is existential in a file campaign, a candidate elsewhere", () => {
    const classExports: Detector = { exports: { declares: ["class"] } };
    expect(subjects(rule(classExports, "file"), at())).toEqual([null]);
    expect(subjects(rule({ not: classExports }, "file"), at())).toEqual([]);
    expect(subjects(rule(classExports, "declaration"), at())).toEqual(["Foo"]);
    // In a match campaign it speaks to the match's anchor.
    expect(
      subjects(rule({ all: [hooks, { exports: { declares: ["variable"] } }] }, "match"), at()),
    ).toEqual([matchKeyOf("Bar", "useState()")]);
  });

  // match-level term × each unit
  it("a match-level term is existential in a file campaign, an anchor in a declaration one, a key in a match one", () => {
    expect(subjects(rule(hooks, "file"), at())).toEqual([null]);
    // The top-level match has no anchor, and sources no declaration.
    expect(subjects(rule(hooks, "declaration"), at())).toEqual(["Bar"]);
    expect(subjects(rule(hooks, "match"), at())).toEqual([
      matchKeyOf(null, "useState()"),
      matchKeyOf("Bar", "useState()"),
    ]);
  });

  it("`not` is the complement within the candidates the other terms produce", () => {
    // Exported declarations that are not classes.
    expect(
      subjects(rule({ all: [{ exports: {} }, { not: classes }] }, "declaration"), at()),
    ).toEqual(["Bar"]);
    // `not` alone has no universe to draw from.
    expect(subjects(rule({ not: classes }, "declaration"), at())).toEqual([]);
    expect(subjects(rule({ any: [classes, { not: hooks }] }, "declaration"), at())).toEqual([
      "Foo",
    ]);
  });

  it("`where.binding` narrows a capture by what its identifier is bound to", () => {
    const facts: SourceFacts = {
      ...NOTHING,
      specifiers: ["react", "./base"],
      bindings: new Map([
        [
          "react",
          [
            { symbol: "Component", kind: "named", local: "C" },
            { symbol: "default", kind: "default", local: "React" },
          ],
        ],
        ["./base", [{ symbol: "Base", kind: "named", local: "Base" }]],
      ]),
    };
    const matches: ReadonlyArray<StagedMatch> = [
      { text: "class A extends C {}", captures: { NAME: "A", BASE: "C" }, anchor: "A" },
      {
        text: "class B extends React.PureComponent {}",
        captures: { NAME: "B", BASE: "React.PureComponent" },
        anchor: "B",
      },
      { text: "class D extends Base {}", captures: { NAME: "D", BASE: "Base" }, anchor: "D" },
      { text: "class E extends Unknown {}", captures: { NAME: "E", BASE: "Unknown" }, anchor: "E" },
    ];
    const edges = { react: "node_modules/react/index.js", "./base": "src/base.ts" };
    const react = (member?: ReadonlyArray<string>) =>
      rule(
        {
          syntax: {
            rule: { pattern: "class $NAME extends $BASE { $$$ }" },
            where: {
              BASE: {
                binding: {
                  resolves: { external: "react" },
                  ...(member === undefined ? {} : { member }),
                },
              },
            },
          },
        },
        "declaration",
      );
    expect(subjects(react(), input({ facts, matches, edges }))).toEqual(["A", "B"]);
    expect(subjects(react(["Component"]), input({ facts, matches, edges }))).toEqual(["A"]);
    expect(subjects(react(["PureComponent"]), input({ facts, matches, edges }))).toEqual(["B"]);
    const local = rule(
      {
        syntax: {
          rule: { pattern: "class $NAME extends $BASE { $$$ }" },
          where: { BASE: { binding: { resolves: "^src/base" } } },
        },
      },
      "declaration",
    );
    expect(subjects(local, input({ facts, matches, edges }))).toEqual(["D"]);
  });
});

describe("evaluation order and short-circuit", () => {
  it("evaluates the cheap terms first and stops an `all` at the first file-level term that fails", () => {
    const calls: Array<string> = [];
    const functions = new Map<string, CampaignPredicate>([
      [
        "./p.mjs#counting",
        () => {
          calls.push("fn");
          return true;
        },
      ],
    ]);
    const never = rule({ all: [{ fn: "./p.mjs#counting" }, { path: { file: "\\.js$" } }] });
    expect(fires(never, input({ functions }))).toBe(false);
    expect(calls).toEqual([]);

    const always = rule({ all: [{ fn: "./p.mjs#counting" }, { path: { file: "\\.ts$" } }] });
    expect(fires(always, input({ functions }))).toBe(true);
    expect(calls).toEqual(["fn"]);
  });

  it("stops an `any` at the first term that holds in a file campaign, and not in the others", () => {
    const calls: Array<string> = [];
    const functions = new Map<string, CampaignPredicate>([
      [
        "./p.mjs#counting",
        () => {
          calls.push("fn");
          return [{ subject: "Widget" }];
        },
      ],
    ]);
    expect(
      fires(
        rule({ any: [{ path: { file: "\\.ts$" } }, { fn: "./p.mjs#counting" }] }),
        input({ functions }),
      ),
    ).toBe(true);
    expect(calls).toEqual([]);
    // In a declaration campaign the function is where the candidates come from.
    expect(
      subjects(
        rule({ any: [{ path: { file: "\\.ts$" } }, { fn: "./p.mjs#counting" }] }, "declaration"),
        input({ functions }),
      ),
    ).toEqual(["Widget"]);
    expect(calls).toEqual(["fn"]);
  });
});

describe("fingerprints anchor on declarations, never on positions", () => {
  const hooks = rule({ syntax: { rule: { pattern: "$HOOK($$$)" } } }, "match");
  const at = (matches: ReadonlyArray<StagedMatch>) => input({ matches });
  const fingerprints = (matches: ReadonlyArray<StagedMatch>) =>
    evaluateObjective(hooks, at(matches)).map((hit) => fingerprintOf(hit.violation));

  it("survives a line shift and a rename of an unrelated declaration", () => {
    const before = fingerprints([{ text: "useState()", anchor: "Bar", line: 3 }]);
    expect(fingerprints([{ text: "useState()", anchor: "Bar", line: 30 }])).toEqual(before);
    expect(
      fingerprints([
        { text: "useState()", anchor: "Bar", line: 30 },
        { text: "other()", anchor: "Renamed", line: 40 },
      ]),
    ).toContain(before[0]);
    expect(before[0]).toBe(`campaign|campaign/x/o|src/a.ts|${matchKeyOf("Bar", "useState()")}`);
  });

  it("changes only when the matched text changes inside the anchor", () => {
    const before = fingerprints([{ text: "useState()", anchor: "Bar" }]);
    const after = fingerprints([{ text: "useState(0)", anchor: "Bar" }]);
    expect(after).not.toEqual(before);
    expect(after[0]?.startsWith("campaign|campaign/x/o|src/a.ts|Bar#")).toBe(true);
  });

  it("a file campaign's fingerprint names the file alone", () => {
    const hit = evaluateObjective(rule({ path: { file: "\\.ts$" } }), input())[0];
    expect(hit === undefined ? "" : fingerprintOf(hit.violation)).toBe(
      "campaign|campaign/x/o|src/a.ts|",
    );
  });
});

describe("selection, probes and the truth table", () => {
  it("selects by scope", () => {
    const one = campaignOf([rule({ path: { file: "." } })]);
    expect(campaignsSelecting([one], "src/a.ts")).toEqual([one]);
    expect(campaignsSelecting([one], "lib/a.ts")).toEqual([]);
  });

  it("a fires probe must fire and an ignores probe must not, naming the term that admitted it", () => {
    const extractor = makeFactExtractorFake({
      "class Foo extends Component {}": {
        specifiers: ["react"],
        bindings: new Map([
          ["react", [{ symbol: "Component", kind: "named", local: "Component" }]],
        ]),
      },
    });
    const matcher = makeSyntaxMatcherFake({
      "class Foo extends Component {}": [
        { text: "class Foo extends Component {}", captures: { BASE: "Component" }, anchor: "Foo" },
      ],
      "class Foo extends Base {}": [
        { text: "class Foo extends Base {}", captures: { BASE: "Base" }, anchor: "Foo" },
      ],
    });
    const react = rule(
      {
        any: [
          {
            syntax: {
              rule: { pattern: "class $N extends $BASE { $$$ }" },
              where: { BASE: { binding: { resolves: { external: "react" } } } },
            },
          },
          { content: { regex: "extends" } },
        ],
      },
      "file",
      {
        probes: {
          fires: [
            {
              path: "src/a.tsx",
              source: "class Foo extends Component {}",
              edges: { react: { external: "react" } },
            },
          ],
          ignores: [{ path: "src/b.tsx", source: "class Foo extends Base {}" }],
        },
      },
    );
    const failed = campaignsFailingTheirProbe(
      [campaignOf([react])],
      extractor,
      () => matcher,
      new Map(),
    );
    expect(failed).toEqual([
      expect.objectContaining({
        name: "campaign/x/o",
        expected: "ignores",
        admittedBy: "content /extends/",
      }),
    ]);

    const outside = rule({ path: { file: "." } }, "file", {
      probes: { fires: [{ path: "lib/a.ts" }], ignores: [] },
    });
    expect(
      campaignsFailingTheirProbe([campaignOf([outside])], extractor, () => null, new Map()),
    ).toEqual([
      expect.objectContaining({ name: "campaign/x/o", expected: "fires", outOfScope: true }),
    ]);

    const silent = rule({ path: { file: "\\.js$" } }, "file", {
      probes: { fires: [{ path: "src/a.ts" }], ignores: [] },
    });
    expect(
      campaignsFailingTheirProbe([campaignOf([silent])], extractor, () => null, new Map()),
    ).toEqual([expect.objectContaining({ name: "campaign/x/o", expected: "fires" })]);
  });

  it("a probe answers a report term from the diagnostics it lists, one-based", () => {
    const tsc = rule({ report: { file: ["tsc.txt"], format: "tsc", codes: ["TS2551"] } }, "match", {
      probes: {
        fires: [
          { path: "src/a.ts", source: "x", report: [{ line: 1, code: "TS2551", message: "m" }] },
        ],
        ignores: [{ path: "src/b.ts", source: "x", report: [{ line: 1, code: "TS7006" }] }],
      },
    });
    expect(
      campaignsFailingTheirProbe(
        [campaignOf([tsc])],
        makeFactExtractorFake({}),
        () => null,
        new Map(),
      ),
    ).toEqual([]);
    const silent = rule({ report: { file: ["tsc.txt"], format: "tsc" } }, "match", {
      probes: { fires: [{ path: "src/a.ts", source: "x" }], ignores: [] },
    });
    expect(
      campaignsFailingTheirProbe(
        [campaignOf([silent])],
        makeFactExtractorFake({}),
        () => null,
        new Map(),
      ),
    ).toEqual([expect.objectContaining({ name: "campaign/x/o", expected: "fires" })]);
  });

  it("explains every leaf term, negations included, with no short-circuit", () => {
    const table = explainObjective(
      rule(
        {
          all: [
            { path: { file: "\\.js$" } },
            { not: { content: { regex: "x" } } },
            { exports: {} },
          ],
        },
        "declaration",
      ),
      input({ text: "x marks" }),
    );
    expect(table).toEqual([
      { term: "path /\\.js$/", answer: false },
      { term: "not content /x/", answer: true },
      { term: "exports", answer: false, count: 0 },
    ]);
  });

  it("refuses an uncompilable pattern with the field named", () => {
    const failed = compileObjective({
      name: "campaign/x/o",
      id: "o",
      campaign: "x",
      message: "m",
      holdout: "file",
      match: { content: { regex: "(" } },
      probes: { fires: [], ignores: [] },
    });
    expect(Result.isFailure(failed) && failed.failure.field).toBe("content.regex");
  });

  // Built by hand rather than decoded, `content: "TODO"` reaches the compiler
  // with no `regex` field, and an undefined pattern is the empty regex — a
  // detector that fires on every file, silently. Refused instead.
  it("refuses a content term that is not { regex }", () => {
    const failed = compileObjective({
      name: "campaign/x/o",
      id: "o",
      campaign: "x",
      message: "m",
      holdout: "file",
      match: { content: "TODO" as never },
      probes: { fires: [], ignores: [] },
    });
    expect(Result.isFailure(failed) && failed.failure.field).toBe("content.regex");
    expect(Result.isFailure(failed) && failed.failure.detail).toContain("{ regex: <string> }");
  });

  // A perimeter is the sector's identity across every phase. One proven
  // only on the shape the campaign is leaving would un-birth the sector
  // the moment the first phase was met, so one fires probe must be a
  // sector no objective fires on.
  it("a match perimeter needs a fires probe in its end shape", () => {
    const matcher = makeSyntaxMatcherFake({
      "export class Page {}": [{ text: "export class Page {}", captures: {}, anchor: "Page" }],
      "export function Page() {}": [
        { text: "export function Page() {}", captures: {}, anchor: "Page" },
      ],
    });
    const oldShape = rule({ syntax: { rule: { pattern: "class $N {}" } } }, "declaration");
    const perimeter = (fires: ReadonlyArray<{ path: string; source: string }>) =>
      campaignOf([oldShape], {
        perimeter: {
          kind: "match",
          match: { exports: {} },
          unit: "declaration",
          probes: { fires, ignores: [] },
        },
      });
    const extractor = makeFactExtractorFake({
      "export class Page {}": {
        exportSites: [
          { file: "src/a.tsx", name: "Page", kind: "named", declares: "class", reexport: false },
        ],
      },
      "export function Page() {}": {
        exportSites: [
          { file: "src/b.tsx", name: "Page", kind: "named", declares: "function", reexport: false },
        ],
      },
    });
    const classMatcher = makeSyntaxMatcherFake({
      "export class Page {}": [{ text: "class Page {}", captures: {}, anchor: "Page" }],
      "export function Page() {}": [],
    });
    void matcher;
    expect(
      campaignsFailingTheirProbe(
        [perimeter([{ path: "src/a.tsx", source: "export class Page {}" }])],
        extractor,
        () => classMatcher,
        new Map(),
      ),
    ).toEqual([expect.objectContaining({ name: "campaign/x/perimeter", expected: "end-shape" })]);
    expect(
      campaignsFailingTheirProbe(
        [
          perimeter([
            { path: "src/a.tsx", source: "export class Page {}" },
            { path: "src/b.tsx", source: "export function Page() {}" },
          ]),
        ],
        extractor,
        () => classMatcher,
        new Map(),
      ),
    ).toEqual([]);
  });
});
