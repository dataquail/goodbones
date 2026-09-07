import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { ImportRule } from "../domain/architecture-config.js";
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

const local = (path: string) => ({ path, kind: "local" as const });

describe("slackOf", () => {
  it("reports every allowance when nothing is imported", () => {
    expect(slackOf(RULES, [])).toEqual([
      { node: "src", kind: "allow", entry: "src/**" },
      { node: "src", kind: "allow", entry: "node:**" },
      { node: "src", kind: "external", entry: "effect" },
      { node: "src/core", kind: "allow", entry: "lib/**" },
    ]);
  });

  it("marks an entry used by an edge from a file its rule selects", () => {
    expect(
      slackOf(RULES, [
        { importer: "src/a.ts", target: local("src/b.ts") },
        { importer: "src/core/x.ts", target: local("lib/y.ts") },
      ]),
    ).toEqual([
      { node: "src", kind: "allow", entry: "node:**" },
      { node: "src", kind: "external", entry: "effect" },
    ]);
  });

  it("judges an external by its package name, never its path", () => {
    expect(
      slackOf(RULES, [
        {
          importer: "src/a.ts",
          target: { path: "node_modules/effect/index.js", kind: "external", package: "effect" },
        },
        { importer: "src/b.ts", target: { path: "node:fs", kind: "builtin" } },
      ]).map((one) => one.entry),
    ).toEqual(["src/**", "lib/**"]);
  });

  it("counts an inherited entry used anywhere under the node that wrote it", () => {
    // `src/**` was written at `src`; a use from under `src/core/` — through the
    // child's rule, since the parent's `fromNot` steps aside there — is a use.
    expect(
      slackOf(RULES, [{ importer: "src/core/x.ts", target: local("src/a.ts") }]).map(
        (one) => one.entry,
      ),
    ).toEqual(["node:**", "effect", "lib/**"]);
  });

  it("ignores an edge from a file no allowlist selects", () => {
    expect(
      slackOf(RULES, [{ importer: "lib/z.ts", target: local("src/a.ts") }]).map((one) => one.entry),
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
    expect(
      slackOf(rules, [{ importer: "src/modules/a/x.ts", target: local("src/modules/b/y.ts") }]),
    ).toHaveLength(1);
    expect(
      slackOf(rules, [{ importer: "src/modules/a/x.ts", target: local("src/modules/a/y.ts") }]),
    ).toEqual([]);
  });
});
