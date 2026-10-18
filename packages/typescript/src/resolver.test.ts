import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ResolveConfig } from "@goodbones/core";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import { makeModuleResolverLive } from "./resolver.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Two scopes, because one is not enough to prove the dispatch works: a file
// under `website/` is resolved through the docs site's own tsconfig, not this
// package's.
const config: ResolveConfig = {
  scopes: [
    { files: "^packages/", language: "typescript", options: { tsconfig: "tsconfig.resolve.json" } },
    { files: "^website/", language: "typescript", options: { tsconfig: "website/tsconfig.json" } },
  ],
};

const unwrap = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure;

  return result.success;
};

const resolver = unwrap(makeModuleResolverLive(repoRoot, config));

const resolve = (fromFile: string, specifier: string) =>
  unwrap(resolver.resolve(fromFile, specifier));

const PLUGIN_FILE = "packages/oxlint/src/plugin.ts";

describe("makeModuleResolverLive", () => {
  // Every one of these is a shape a real repository's imports take. A gap here
  // is not a missing feature — it is a rule that stops reporting.
  it("resolves a NodeNext relative specifier through its .js extension", () => {
    expect(resolve(PLUGIN_FILE, "./config-loader.js").path).toBe(
      "packages/oxlint/src/config-loader.ts",
    );
  });

  it("resolves a workspace package by name to its source barrel", () => {
    expect(resolve(PLUGIN_FILE, "@goodbones/core").path).toBe("packages/core/src/index.ts");
  });

  it("resolves a workspace package subpath to its source file", () => {
    expect(resolve(PLUGIN_FILE, "@goodbones/core/testing").path).toBe(
      "packages/core/src/testing.ts",
    );
  });

  it("resolves an npm subpath into node_modules and marks it external, by package name", () => {
    const target = resolve(PLUGIN_FILE, "effect/Schema");
    expect(target.kind).toBe("external");
    expect(target.package).toBe("effect");
    expect(target.path).toMatch(/node_modules\/effect\/dist\/Schema\.js$/);
  });

  it("does not report a package for a repository file", () => {
    expect(resolve(PLUGIN_FILE, "./config-loader.js").package).toBeUndefined();
  });

  // A builtin is its own kind: a rule fencing off npm dependencies must not
  // catch `node:crypto`.
  it("resolves a node builtin as its own dependency kind", () => {
    expect(resolve(PLUGIN_FILE, "node:crypto")).toEqual({ path: "node:crypto", kind: "builtin" });
  });

  it("fails on a specifier that resolves to nothing", () => {
    expect(Result.isFailure(resolver.resolve(PLUGIN_FILE, "nowhere-at-all"))).toBe(true);
  });

  it("fails on a file no resolve scope covers, rather than passing it silently", () => {
    expect(Result.isFailure(resolver.resolve("scripts/lint-rules/index.mjs", "node:path"))).toBe(
      true,
    );
  });

  it("resolves a file in a second scope through that scope's own tsconfig", () => {
    const target = resolve("website/src/content.config.ts", "@astrojs/starlight/loaders");
    expect(target.kind).toBe("external");
    expect(target.path).toMatch(/@astrojs\/starlight\/loaders\.ts$/);
  });

  // A scoped package is two path segments, and pnpm's store puts a second
  // `node_modules/` in front of the real one.
  it("names a scoped package by both segments, from the last node_modules on the path", () => {
    expect(resolve("website/src/content.config.ts", "@astrojs/starlight/loaders").package).toBe(
      "@astrojs/starlight",
    );
  });
});

describe("scope options", () => {
  const scope = (options: unknown) =>
    makeModuleResolverLive(repoRoot, {
      scopes: [{ files: "", language: "typescript", options }],
    });

  // Every option is read from the scope, never from the manifest's top level.
  it("honours the scope's own extensions", () => {
    const withoutTs = unwrap(scope({ tsconfig: "tsconfig.resolve.json", extensions: [".json"] }));
    expect(Result.isFailure(withoutTs.resolve(PLUGIN_FILE, "./config-loader"))).toBe(true);
    const withTs = unwrap(scope({ tsconfig: "tsconfig.resolve.json", extensions: [".ts"] }));
    expect(Result.isSuccess(withTs.resolve(PLUGIN_FILE, "./config-loader"))).toBe(true);
  });

  it("refuses a scope with no tsconfig", () => {
    expect(Result.isFailure(scope(undefined))).toBe(true);
    expect(Result.isFailure(scope({}))).toBe(true);
  });

  // A misspelled option would otherwise be a resolver quietly built on
  // defaults, and every rule about that scope evaluated against the wrong files.
  it("refuses an option it does not know", () => {
    const outcome = scope({ tsconfig: "tsconfig.resolve.json", mainField: ["main"] });
    expect(Result.isFailure(outcome) && outcome.failure.message).toMatch(/mainField/);
  });

  it("refuses a scope for a language it does not serve", () => {
    const outcome = makeModuleResolverLive(repoRoot, {
      scopes: [{ files: "", language: "go", options: {} }],
    });

    expect(Result.isFailure(outcome) && outcome.failure.message).toMatch(/"go" scope/);
  });
});
