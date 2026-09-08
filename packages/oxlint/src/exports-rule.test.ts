import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileExportRules,
  EMPTY_BASELINE,
  EMPTY_GRAPH_RULES,
  EMPTY_STRUCTURE,
  type LoadedPolicy,
  makeBaselineFilter,
} from "@goodbones/core";
import {
  makeFactExtractorFake,
  makeFileSystemFake,
  makeModuleResolverFake,
} from "@goodbones/core/testing";
import * as Result from "effect/Result";
import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import { makeExportsRule } from "./exports-rule.js";

RuleTester.describe = describe;
RuleTester.it = it;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const CQRS_BARREL =
  "node_modules/.pnpm/@effect-server-utils+cqrs/node_modules/@effect-server-utils/cqrs/dist/esm/index.js";
const EFFECT_BARREL = "node_modules/.pnpm/effect@4.0.0-beta.94/node_modules/effect/dist/index.js";

const config = {
  resolve: {
    scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.resolve.json" } }],
  },
  exports: [
    {
      name: "bus-factories-at-composition-roots",
      message: "Only a composition root may build a bus.",
      probe: {
        from: "packages/server/src/modules/todos/commands/probe.handler.ts",
        to: CQRS_BARREL,
        symbol: "makeCommandBus",
      },
      from: "^packages/server/src/",
      fromNot: "^packages/server/src/cqrs-runtime\\.ts$",
      to: "/node_modules/@effect-server-utils/cqrs/",
      symbols: ["makeCommandBus"],
    },
    {
      name: "no-effect-namespace-imports",
      message: "Import the module by its own subpath as a namespace.",
      probe: { from: "packages/server/src/probe.ts", to: EFFECT_BARREL, symbol: "Effect" },
      from: "^packages/",
      to: "/node_modules/effect/dist/index\\.js$",
      fix: "subpath-namespace-import" as const,
    },
  ],
};

const policy = (): LoadedPolicy => {
  const exportRules = compileExportRules(config.exports);
  if (Result.isFailure(exportRules)) throw exportRules.failure;
  return {
    repoRoot,
    config: { resolve: config.resolve, tree: {} },
    importRules: [],
    exportRules: exportRules.success,
    memberRules: [],
    structure: EMPTY_STRUCTURE,
    surfaceRules: [],
    graph: EMPTY_GRAPH_RULES,
    adoption: { unrestricted: [], partial: [] },
    nodes: [],
    fileSystem: makeFileSystemFake([]),
    languages: [],
    extractor: makeFactExtractorFake({}),
    resolver: makeModuleResolverFake({
      "@effect-server-utils/cqrs": CQRS_BARREL,
      effect: EFFECT_BARREL,
      "effect/Effect": "node_modules/.pnpm/effect@4.0.0-beta.94/node_modules/effect/dist/Effect.js",
    }),
    ignoreUnresolved: [],
    notices: [],
    baseline: makeBaselineFilter(EMPTY_BASELINE),
  };
};

const HANDLER = path.join(
  repoRoot,
  "packages/server/src/modules/todos/commands/create-todo.handler.ts",
);
const COMPOSITION_ROOT = path.join(repoRoot, "packages/server/src/cqrs-runtime.ts");

new RuleTester({ cwd: repoRoot }).run("exports", makeExportsRule(policy()), {
  valid: [
    { code: 'import { CommandBus } from "@effect-server-utils/cqrs";', filename: HANDLER },
    {
      code: 'import { makeCommandBus } from "@effect-server-utils/cqrs";',
      filename: COMPOSITION_ROOT,
    },
    { code: 'import * as Effect from "effect/Effect";', filename: HANDLER },
    // An unresolvable specifier is `architecture/imports`' diagnostic to report;
    // reporting it twice for one broken import helps nobody.
    { code: 'import { anything } from "@org/nowhere";', filename: HANDLER },
  ],
  invalid: [
    {
      code: 'import { makeCommandBus } from "@effect-server-utils/cqrs";',
      filename: HANDLER,
      errors: [{ message: /^\[bus-factories-at-composition-roots\]/ }],
    },
    {
      code: 'import { Effect } from "effect";',
      filename: HANDLER,
      errors: [{ message: /^\[no-effect-namespace-imports\]/ }],
      output: 'import * as Effect from "effect/Effect";',
    },
    {
      // The alias has to survive the rewrite, or the fix breaks every use site.
      code: 'import { Effect, Layer as L } from "effect";',
      filename: HANDLER,
      errors: [{ message: /^\[no-effect-namespace-imports\]/ }],
      output: 'import * as Effect from "effect/Effect";\nimport * as L from "effect/Layer";',
    },
    {
      // Mixed with a default import: reported, but deliberately not rewritten —
      // that fix would need comma surgery inside the braces.
      code: 'import def, { Effect } from "effect";',
      filename: HANDLER,
      errors: [{ message: /^\[no-effect-namespace-imports\]/ }],
      output: null,
    },
  ],
});

new RuleTester({ cwd: repoRoot }).run("exports (binding forms)", makeExportsRule(policy()), {
  valid: [
    // Nothing crosses a side-effect import, and a namespace import is the form
    // the fix steers toward.
    { code: 'import "@effect-server-utils/cqrs";', filename: HANDLER },
    { code: 'import * as Cqrs from "@effect-server-utils/cqrs";', filename: HANDLER },
    { code: "export const x = 1;", filename: HANDLER },
  ],
  invalid: [
    {
      // A re-export names the symbol in the source module just as an import does.
      code: 'export { makeCommandBus } from "@effect-server-utils/cqrs";',
      filename: HANDLER,
      errors: [{ message: /^\[bus-factories-at-composition-roots\]/ }],
    },
    {
      code: 'import { "makeCommandBus" as make } from "@effect-server-utils/cqrs";',
      filename: HANDLER,
      errors: [{ message: /^\[bus-factories-at-composition-roots\]/ }],
    },
  ],
});

new RuleTester({ cwd: repoRoot }).run(
  "exports (baselined)",
  makeExportsRule({
    ...policy(),
    baseline: makeBaselineFilter({
      version: 1,
      entries: [
        `export|bus-factories-at-composition-roots|packages/server/src/modules/todos/commands/create-todo.handler.ts|${CQRS_BARREL}#makeCommandBus`,
      ],
    }),
  }),
  {
    valid: [
      { code: 'import { makeCommandBus } from "@effect-server-utils/cqrs";', filename: HANDLER },
    ],
    invalid: [],
  },
);

// Every form that takes the whole module at once carries one namespace
// binding, named `*`. A rule with `kinds: ["namespace"]` and no `symbols` is
// how a policy forbids the form — including the `export *` that launders every
// symbol past a `symbols` rule, and the `import()` that names no binding.
const wholeModulePolicy = (): LoadedPolicy => {
  const exportRules = compileExportRules([
    {
      name: "no-whole-module",
      message: "Name what you take from the bus package.",
      probe: {
        from: "packages/server/src/probe.ts",
        to: CQRS_BARREL,
        symbol: "*",
        kind: "namespace",
      },
      from: "^packages/server/src/",
      to: "/node_modules/@effect-server-utils/cqrs/",
      kinds: ["namespace"],
      fix: "subpath-namespace-import",
    },
  ]);
  if (Result.isFailure(exportRules)) throw exportRules.failure;
  return { ...policy(), exportRules: exportRules.success };
};

new RuleTester({ cwd: repoRoot }).run(
  "exports (whole-module forms)",
  makeExportsRule(wholeModulePolicy()),
  {
    valid: [
      { code: 'import { makeQueryBus } from "@effect-server-utils/cqrs";', filename: HANDLER },
      { code: 'import bus from "@effect-server-utils/cqrs";', filename: HANDLER },
      { code: 'import "@effect-server-utils/cqrs";', filename: HANDLER },
    ],
    invalid: [
      'import * as cqrs from "@effect-server-utils/cqrs";',
      'export * from "@effect-server-utils/cqrs";',
      'export * as cqrs from "@effect-server-utils/cqrs";',
      'import cqrs = require("@effect-server-utils/cqrs");',
      'const cqrs = await import("@effect-server-utils/cqrs");',
      'const cqrs = require("@effect-server-utils/cqrs");',
    ].map((code) => ({
      code,
      filename: HANDLER,
      errors: [{ message: /^\[no-whole-module\]/ }],
      // The rule carries a fix, but the rewrite is `import * as X from
      // "pkg/<name>"`, which only means something for a named binding. None of
      // these has one; all are reported and left to the author.
      output: null,
    })),
  },
);
