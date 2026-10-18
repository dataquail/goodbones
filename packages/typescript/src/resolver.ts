import * as path from "node:path";

import {
  ImportUnresolved,
  type ModuleResolver,
  type ResolveConfig,
  type ResolvedTarget,
  type ResolveScope,
  ScopeInvalid,
} from "@goodbones/core";
import * as Result from "effect/Result";
import { ResolverFactory } from "unrs-resolver";

import { npmPackageOf } from "./npm-package.js";
import { decodeTypescriptScopeOptions, type TypescriptScopeOptions } from "./options.js";

// `.js` in a NodeNext import specifier points at a `.ts` on disk. Without this,
// every relative import in the repo resolves to nothing and every path rule about
// it goes silently vacuous — the failure this package exists to make impossible.
const EXTENSION_ALIAS = {
  ".js": [".ts", ".tsx", ".js"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
};

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const DEFAULT_CONDITION_NAMES = ["import", "require", "node", "default"];
const DEFAULT_MAIN_FIELDS = ["main", "types"];

export const TYPESCRIPT = "typescript";

const toPosix = (value: string): string => value.replaceAll(path.sep, "/");

// A file under `node_modules/` is a third-party package, and the policy speaks
// about it by the package's name rather than by where pnpm or npm put it.
const toResolvedTarget = (repoRoot: string, absolutePath: string): ResolvedTarget => {
  const relative = toPosix(path.relative(repoRoot, absolutePath));
  const pkg = npmPackageOf(relative);

  return pkg === undefined
    ? { path: relative, kind: "local" }
    : { path: relative, kind: "external", package: pkg };
};

type Scope = {
  readonly matches: RegExp;
  readonly factory: ResolverFactory;
};

const factoryOf = (repoRoot: string, options: TypescriptScopeOptions): ResolverFactory =>
  new ResolverFactory({
    tsconfig: { configFile: path.resolve(repoRoot, options.tsconfig) },
    extensions: [...(options.extensions ?? DEFAULT_EXTENSIONS)],
    extensionAlias: EXTENSION_ALIAS,
    conditionNames: [...(options.conditionNames ?? DEFAULT_CONDITION_NAMES)],
    mainFields: [...(options.mainFields ?? DEFAULT_MAIN_FIELDS)],
    builtinModules: true,
  });

// Every scope here is TypeScript's: this resolver is the one the TypeScript pack
// hands out, and a scope naming another language is one it cannot serve.
const scopeOf = (repoRoot: string, scope: ResolveScope): Result.Result<Scope, ScopeInvalid> => {
  if (scope.language !== TYPESCRIPT) {
    return Result.fail(
      new ScopeInvalid({
        files: scope.files,
        language: scope.language,
        detail: `the TypeScript resolver cannot serve a "${scope.language}" scope`,
      }),
    );
  }

  return Result.map(decodeTypescriptScopeOptions(scope), (options) => ({
    matches: new RegExp(scope.files),
    factory: factoryOf(repoRoot, options),
  }));
};

export const makeModuleResolverLive = (
  repoRoot: string,
  config: ResolveConfig,
): Result.Result<ModuleResolver, ScopeInvalid> => {
  const scopes: Array<Scope> = [];

  for (const entry of config.scopes) {
    const scope = scopeOf(repoRoot, entry);

    if (Result.isFailure(scope)) return Result.fail(scope.failure);
    scopes.push(scope.success);
  }

  const cache = new Map<string, Result.Result<ResolvedTarget, ImportUnresolved>>();

  const resolveUncached = (
    scope: Scope,
    fromDirectory: string,
    fromFile: string,
    specifier: string,
  ): Result.Result<ResolvedTarget, ImportUnresolved> => {
    const resolved = scope.factory.sync(fromDirectory, specifier);

    const builtin = resolved.builtin;

    if (builtin !== undefined) {
      return Result.succeed({ path: builtin.resolved, kind: "builtin" });
    }

    const resolvedPath = resolved.path;

    if (resolvedPath === undefined) {
      return Result.fail(
        new ImportUnresolved({
          fromFile,
          specifier,
          detail: resolved.error ?? "unknown resolution failure",
        }),
      );
    }

    return Result.succeed(toResolvedTarget(repoRoot, resolvedPath));
  };

  return Result.succeed({
    resolve: (fromFile, specifier) => {
      const scope = scopes.find((candidate) => candidate.matches.test(fromFile));

      if (scope === undefined) {
        return Result.fail(
          new ImportUnresolved({
            fromFile,
            specifier,
            detail: "no resolve scope in the architecture config matches this file",
          }),
        );
      }

      const fromDirectory = path.resolve(repoRoot, path.dirname(fromFile));
      const key = `${scope.matches.source} ${fromDirectory} ${specifier}`;
      const cached = cache.get(key);

      if (cached !== undefined) return cached;

      const outcome = resolveUncached(scope, fromDirectory, fromFile, specifier);
      cache.set(key, outcome);

      return outcome;
    },
  });
};
