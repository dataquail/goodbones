import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileSurfaceRules,
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

import { makeSurfaceRule } from "./surface-rule.js";

RuleTester.describe = describe;
RuleTester.it = it;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const config = {
  resolve: {
    scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.resolve.json" } }],
  },
  surface: [
    {
      name: "no-default-exports",
      message: "A default export has no name to grep for.",
      probe: {
        from: "packages/web/src/x.ts",
        sites: [{ name: "default", kind: "default" as const }],
      },
      from: "^packages/web/src/",
      kinds: ["default" as const],
    },
    {
      name: "barrel-reexports",
      message: "A barrel re-exports; `{name}` is declared here.",
      probe: {
        from: "packages/web/src/index.ts",
        sites: [{ name: "helper", kind: "named" as const, reexport: false }],
      },
      from: "^packages/web/src/index\\.ts$",
      reexport: false,
    },
    {
      name: "one-handler",
      message: "A handler exports exactly one function.",
      probe: { from: "packages/web/src/x.handler.ts", sites: [] },
      from: "\\.handler\\.ts$",
      declares: ["function" as const],
      count: { min: 1, max: 1 },
    },
    {
      name: "camel-handlers",
      message: "`{name}` is not camelCase.",
      probe: {
        from: "packages/web/src/x.handler.ts",
        sites: [{ name: "Create_Todo", kind: "named" as const }],
      },
      from: "\\.handler\\.ts$",
      kinds: ["named" as const],
      // A type beside the function is PascalCase by convention; the rule is
      // about the values.
      declares: ["function" as const, "variable" as const],
      convention: "^[a-z][a-zA-Z0-9]*$",
    },
  ],
};

const policy = (): LoadedPolicy => {
  const surfaceRules = compileSurfaceRules(config.surface);
  if (Result.isFailure(surfaceRules)) throw surfaceRules.failure;
  return {
    repoRoot,
    config: { resolve: config.resolve, tree: {} },
    importRules: [],
    exportRules: [],
    memberRules: [],
    surfaceRules: surfaceRules.success,
    graph: EMPTY_GRAPH_RULES,
    adoption: { unrestricted: [], partial: [] },
    nodes: [],
    structure: EMPTY_STRUCTURE,
    fileSystem: makeFileSystemFake([]),
    languages: [],
    extractor: makeFactExtractorFake({}),
    resolver: makeModuleResolverFake({}),
    ignoreUnresolved: [],
    notices: [],
    baseline: makeBaselineFilter(EMPTY_BASELINE),
  };
};

const MODULE = path.join(repoRoot, "packages/web/src/thing.ts");
const BARREL = path.join(repoRoot, "packages/web/src/index.ts");
const HANDLER = path.join(repoRoot, "packages/web/src/create-todo.handler.ts");
const OUTSIDE = path.join(repoRoot, "packages/server/src/thing.ts");

new RuleTester({ cwd: repoRoot }).run("surface", makeSurfaceRule(policy()), {
  valid: [
    { code: "export const thing = 1;", filename: MODULE },
    // A default export in a file the rule does not select.
    { code: "export default 1;", filename: OUTSIDE },
    // An `export` inside a namespace body is that namespace's, not the module's.
    { code: "namespace N { export const helper = 1; }", filename: BARREL },
    { code: 'export { Todo } from "./todo.js"; export * from "./ids.js";', filename: BARREL },
    { code: "export function createTodo() {}", filename: HANDLER },
    // A type beside the function is not a function, so it is not counted.
    { code: "export type Deps = {}; export function createTodo() {}", filename: HANDLER },
  ],
  invalid: [
    {
      code: "export default function main() {}",
      filename: MODULE,
      errors: [{ message: /^\[no-default-exports\]/ }],
    },
    {
      code: "const x = 1; export { x as default };",
      filename: MODULE,
      errors: [{ message: /^\[no-default-exports\]/ }],
    },
    {
      code: 'export const helper = 1; export { Todo } from "./todo.js";',
      filename: BARREL,
      errors: [{ message: /^\[barrel-reexports\] A barrel re-exports; `helper`/ }],
    },
    {
      code: "export const createTodo = 1;",
      filename: HANDLER,
      errors: [{ message: /^\[one-handler\]/ }],
    },
    {
      code: "export function createTodo() {} export function deleteTodo() {}",
      filename: HANDLER,
      errors: [{ message: /^\[one-handler\]/ }],
    },
    {
      code: "export function Create_Todo() {}",
      filename: HANDLER,
      errors: [{ message: /^\[camel-handlers\] `Create_Todo`/ }],
    },
  ],
});
