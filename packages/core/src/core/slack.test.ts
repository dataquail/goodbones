import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { Allowance, ImportRule } from "../domain/architecture-config.js";
import { compileImportRules } from "./imports.js";
import { slackOf } from "./slack.js";

const compile = (rules: ReadonlyArray<ImportRule>) => {
  const compiled = compileImportRules(rules);
  if (Result.isFailure(compiled)) throw compiled.failure;
  return compiled.success;
};

const probe = { from: "src/core/zz.ts", to: "src/nowhere.ts" };

// A parent allowlist, inherited by a child that adds an entry of its own —
// the shape lowering produces, written flat.
const RULES = compile([
  {
    name: "src/imports",
    message: "…",
    probe,
    from: "^src/",
    fromNot: "^src/core/",
    toNot: ["^src(/.*)?$", "^node:"],
    externals: ["effect"],
    allowances: [
      { node: "src", kind: "allow", entry: "src/**", pattern: "^src(/.*)?$" },
      { node: "src", kind: "allow", entry: "node:**", pattern: "^node:" },
      { node: "src", kind: "external", entry: "effect" },
    ],
  },
  {
    name: "src/core/imports",
    message: "…",
    probe,
    from: "^src/core/",
    toNot: ["^src(/.*)?$", "^node:", "^lib(/.*)?$"],
    externals: ["effect"],
    allowances: [
      { node: "src", kind: "allow", entry: "src/**", pattern: "^src(/.*)?$" },
      { node: "src", kind: "allow", entry: "node:**", pattern: "^node:" },
      { node: "src", kind: "external", entry: "effect" },
      { node: "src/core", kind: "allow", entry: "lib/**", pattern: "^lib(/.*)?$" },
    ],
  },
  // A prohibition carries no allowances and contributes nothing.
  { name: "deny", message: "…", probe, from: "^src/", to: "^src/secret/" },
]);

// Every rule above selects something here, so nothing is vacant.
const FILES = ["src/a.ts", "src/b.ts", "src/core/x.ts"];

const local = (path: string) => ({ path, kind: "local" as const });

const slack = (...args: Parameters<typeof slackOf>) => slackOf(...args).slack;

describe("slackOf", () => {
  it("reports every allowance when nothing is imported", () => {
    expect(slackOf(RULES, [], FILES)).toEqual({
      slack: [
        { node: "src", kind: "allow", entry: "src/**" },
        { node: "src", kind: "allow", entry: "node:**" },
        { node: "src", kind: "external", entry: "effect" },
        { node: "src/core", kind: "allow", entry: "lib/**" },
      ],
      concentration: [],
    });
  });

  it("marks an entry used by an edge from a file its rule selects", () => {
    expect(
      slack(
        RULES,
        [
          { importer: "src/a.ts", target: local("src/b.ts") },
          { importer: "src/core/x.ts", target: local("lib/y.ts") },
        ],
        FILES,
      ),
    ).toEqual([
      { node: "src", kind: "allow", entry: "node:**" },
      { node: "src", kind: "external", entry: "effect" },
    ]);
  });

  it("judges an external by its package name, never its path", () => {
    expect(
      slack(
        RULES,
        [
          {
            importer: "src/a.ts",
            target: { path: "node_modules/effect/index.js", kind: "external", package: "effect" },
          },
          { importer: "src/b.ts", target: { path: "node:fs", kind: "builtin" } },
        ],
        FILES,
      ).map((one) => one.entry),
    ).toEqual(["src/**", "lib/**"]);
  });

  it("counts an inherited entry used anywhere under the node that wrote it", () => {
    // `src/**` was written at `src`; a use from under `src/core/` — through the
    // child's rule, since the parent's `fromNot` steps aside there — is a use.
    expect(
      slack(RULES, [{ importer: "src/core/x.ts", target: local("src/a.ts") }], FILES).map(
        (one) => one.entry,
      ),
    ).toEqual(["node:**", "effect", "lib/**"]);
  });

  it("ignores an edge from a file no allowlist selects", () => {
    expect(
      slack(RULES, [{ importer: "lib/z.ts", target: local("src/a.ts") }], FILES).map(
        (one) => one.entry,
      ),
    ).toEqual(["src/**", "node:**", "effect", "lib/**"]);
  });

  it("substitutes a capture from the importer into the pattern", () => {
    const rules = compile([
      {
        name: "modules/{m}/imports",
        message: "…",
        probe: { from: "src/modules/alpha/zz.ts", to: "src/nowhere.ts" },
        from: "^src/modules/([^/]+)/",
        toNot: ["^src/modules/$1(/.*)?$"],
        allowances: [
          {
            node: "modules/{m}",
            kind: "allow",
            entry: "src/modules/{m}/**",
            pattern: "^src/modules/$1(/.*)?$",
          },
        ],
      },
    ]);
    const files = ["src/modules/a/x.ts", "src/modules/a/y.ts", "src/modules/b/y.ts"];
    expect(
      slack(
        rules,
        [{ importer: "src/modules/a/x.ts", target: local("src/modules/b/y.ts") }],
        files,
      ),
    ).toHaveLength(1);
    expect(
      slack(
        rules,
        [{ importer: "src/modules/a/x.ts", target: local("src/modules/a/y.ts") }],
        files,
      ),
    ).toEqual([]);
  });
});

describe("slackOf over a vacant node", () => {
  // `src/core/` has no file: its rule selects nothing, so its `lib/**` is
  // unused by construction — vacancy, not a line to delete. `src`'s entries
  // still reach the files under `src/` and are measured as before.
  it("contributes nothing from a node whose allowlist selects no file", () => {
    expect(slack(RULES, [], ["src/a.ts"]).map((one) => one.entry)).toEqual([
      "src/**",
      "node:**",
      "effect",
    ]);
  });

  // `src`'s own rule steps aside under `src/core/`, but its allowlist is
  // inherited there — a node that grants permission to some file is not vacant.
  it("keeps a parent whose only files sit under an overriding child", () => {
    expect(slack(RULES, [], ["src/core/x.ts"]).map((one) => one.entry)).toEqual([
      "src/**",
      "node:**",
      "effect",
      "lib/**",
    ]);
  });

  it("reports nothing over an empty tree", () => {
    expect(slackOf(RULES, [], [])).toEqual({ slack: [], concentration: [] });
  });
});

describe("slackOf through a fragment", () => {
  // Three nodes that each wrote `use: shared`, and one that wrote the same
  // entries by hand. Lowering stamps the fragment on the first three.
  const via = (node: string, fragment: string | undefined): ReadonlyArray<Allowance> => [
    {
      node,
      kind: "allow",
      entry: "lib/**",
      pattern: "^lib(/.*)?$",
      ...(fragment === undefined ? {} : { fragment }),
    },
    { node, kind: "external", entry: "effect", ...(fragment === undefined ? {} : { fragment }) },
  ];
  const rule = (node: string, fragment: string | undefined): ImportRule => ({
    name: `${node}/imports`,
    message: "…",
    probe: { from: `${node}/zz.ts`, to: "src/nowhere.ts" },
    from: `^${node}/`,
    toNot: ["^lib(/.*)?$"],
    externals: ["effect"],
    allowances: via(node, fragment),
  });
  const rules = compile([
    rule("src/a", "shared"),
    rule("src/b", "shared"),
    rule("src/c", "shared"),
    rule("src/own", undefined),
  ]);
  const files = ["src/a/x.ts", "src/b/x.ts", "src/c/x.ts", "src/own/x.ts"];
  const effect = {
    path: "node_modules/effect/index.js",
    kind: "external" as const,
    package: "effect",
  };

  it("reports an entry no node uses once, against the fragment, with how many were granted it", () => {
    expect(slackOf(rules, [], files).slack).toEqual([
      { node: "shared", kind: "allow", entry: "lib/**", fragment: "shared", of: 3 },
      { node: "shared", kind: "external", entry: "effect", fragment: "shared", of: 3 },
      { node: "src/own", kind: "allow", entry: "lib/**" },
      { node: "src/own", kind: "external", entry: "effect" },
    ]);
  });

  it("reports an entry used at some of the nodes as concentration, not slack", () => {
    const report = slackOf(rules, [{ importer: "src/b/x.ts", target: effect }], files);
    expect(report.slack.map((one) => `${one.node} ${one.entry}`)).toEqual([
      "shared lib/**",
      "src/own lib/**",
      "src/own effect",
    ]);
    expect(report.concentration).toEqual([
      { fragment: "shared", kind: "external", entry: "effect", usedAt: 1, of: 3 },
    ]);
  });

  it("reports nothing for an entry every node uses", () => {
    const report = slackOf(
      rules,
      [
        { importer: "src/a/x.ts", target: effect },
        { importer: "src/b/x.ts", target: effect },
        { importer: "src/c/x.ts", target: effect },
      ],
      files,
    );
    expect(report.slack.map((one) => `${one.node} ${one.entry}`)).toEqual([
      "shared lib/**",
      "src/own lib/**",
      "src/own effect",
    ]);
    expect(report.concentration).toEqual([]);
  });

  // A vacant node is neither granted nor counted: `of` is the nodes with files.
  it("leaves a vacant node out of the count", () => {
    const report = slackOf(rules, [{ importer: "src/b/x.ts", target: effect }], [
      "src/a/x.ts",
      "src/b/x.ts",
    ]);
    expect(report.slack[0]).toEqual({
      node: "shared",
      kind: "allow",
      entry: "lib/**",
      fragment: "shared",
      of: 2,
    });
    expect(report.concentration).toEqual([
      { fragment: "shared", kind: "external", entry: "effect", usedAt: 1, of: 2 },
    ]);
  });

  it("keeps a node-authored entry keyed by the node, as before", () => {
    const report = slackOf(rules, [{ importer: "src/own/x.ts", target: effect }], files);
    expect(report.slack).toContainEqual({ node: "src/own", kind: "allow", entry: "lib/**" });
    expect(report.slack).not.toContainEqual(
      expect.objectContaining({ node: "src/own", entry: "effect" }),
    );
  });
});
