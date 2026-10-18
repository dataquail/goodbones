import * as Match from "effect/Match";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { SurfaceRule } from "../domain/architecture-config.js";
import type { ExportSite } from "../domain/facts.js";
import { makeFactExtractorFake } from "../infrastructure/fact-extractor-fake.js";
import {
  compileSurfaceRules,
  evaluateSurface,
  surfaceRulesFailingTheirProbe,
  surfaceRulesSelecting,
} from "./surface.js";

const compile = (rules: ReadonlyArray<SurfaceRule>) => {
  const compiled = compileSurfaceRules(rules);

  if (Result.isFailure(compiled)) throw compiled.failure;

  return compiled.success;
};

const HANDLER = "packages/server/src/modules/todos/commands/create-todo.handler.ts";
const BARREL = "packages/server/src/modules/todos/index.ts";

const kindOf = (name: string): ExportSite["kind"] =>
  Match.value(name).pipe(
    Match.when("default", (): ExportSite["kind"] => "default"),
    Match.when("*", (): ExportSite["kind"] => "namespace"),
    Match.orElse((): ExportSite["kind"] => "named"),
  );

const site = (name: string, overrides: Partial<ExportSite> = {}): ExportSite => ({
  file: HANDLER,
  name,
  kind: kindOf(name),
  declares: "variable",
  reexport: false,
  ...overrides,
});

const noDefault: SurfaceRule = {
  name: "no-default-exports",
  message: "A default export has no name to grep for.",
  probe: { from: HANDLER, sites: [{ name: "default", kind: "default" }] },
  from: "^packages/server/src/",
  kinds: ["default"],
};

const oneHandler: SurfaceRule = {
  name: "one-handler",
  message: "A handler exports exactly one function.",
  probe: { from: HANDLER, sites: [] },
  from: "\\.handler\\.ts$",
  declares: ["function", "variable"],
  count: { min: 1, max: 1 },
};

const camel: SurfaceRule = {
  name: "camel-handlers",
  message: "`{name}` is not camelCase.",
  probe: { from: HANDLER, sites: [{ name: "Create_Todo", kind: "named" }] },
  from: "\\.handler\\.ts$",
  kinds: ["named"],
  convention: "^[a-z][a-zA-Z0-9]*$",
};

const barrelOnlyReexports: SurfaceRule = {
  name: "barrel-reexports",
  message: "A barrel re-exports; `{name}` is declared here.",
  probe: { from: BARREL, sites: [{ name: "helper", kind: "named", reexport: false }] },
  from: "/index\\.ts$",
  reexport: false,
};

const publicNames: SurfaceRule = {
  name: "public-names",
  message: "`{name}` is not part of the module's public vocabulary.",
  probe: { from: BARREL, sites: [{ name: "zzStray", kind: "named" }] },
  from: "/index\\.ts$",
  allow: ["^Todo", "^make"],
};

const names = (
  rules: ReadonlyArray<SurfaceRule>,
  file: string,
  sites: ReadonlyArray<ExportSite>,
): ReadonlyArray<string> =>
  evaluateSurface(surfaceRulesSelecting(compile(rules), file), file, sites).map(
    (violation) => `${violation.ruleName}:${violation.subject ?? ""}`,
  );

describe("evaluateSurface", () => {
  it("forbid: every selected site is a violation, and an unselected one is not", () => {
    expect(names([noDefault], HANDLER, [site("createTodo"), site("default")])).toEqual([
      "no-default-exports:default",
    ]);
  });

  it("count: one violation about the file, with no subject", () => {
    expect(names([oneHandler], HANDLER, [])).toEqual(["one-handler:"]);
    expect(names([oneHandler], HANDLER, [site("a"), site("b")])).toEqual(["one-handler:"]);
    expect(names([oneHandler], HANDLER, [site("createTodo")])).toEqual([]);
  });

  it("count: sites the selectors do not speak to are not counted", () => {
    expect(
      names([oneHandler], HANDLER, [site("createTodo"), site("Deps", { declares: "type" })]),
    ).toEqual([]);
  });

  it("convention: each selected name that fails the shape", () => {
    expect(names([camel], HANDLER, [site("createTodo"), site("Create_Todo")])).toEqual([
      "camel-handlers:Create_Todo",
    ]);
  });

  it("reexport: `false` speaks only to what the file declares", () => {
    const declared = site("helper", { file: BARREL });
    const forwarded = site("Todo", { file: BARREL, reexport: true, declares: "other" });
    expect(names([barrelOnlyReexports], BARREL, [declared, forwarded])).toEqual([
      "barrel-reexports:helper",
    ]);
  });

  it("allow: a selected name the allowlist does not admit", () => {
    expect(
      names([publicNames], BARREL, [
        site("TodoId", { file: BARREL }),
        site("makeTodos", { file: BARREL }),
        site("internal", { file: BARREL }),
      ]),
    ).toEqual(["public-names:internal"]);
  });

  it("selects by the file's path, so a rule about handlers says nothing about a barrel", () => {
    expect(names([oneHandler], BARREL, [])).toEqual([]);
  });
});

describe("surfaceRulesFailingTheirProbe", () => {
  const NO_PARSER = makeFactExtractorFake({});

  it("passes rules that report their own probes", () => {
    expect(
      surfaceRulesFailingTheirProbe(
        compile([noDefault, oneHandler, camel, barrelOnlyReexports, publicNames]),
        NO_PARSER,
      ),
    ).toEqual([]);
  });

  it("catches a rule whose selectors no longer reach its probe", () => {
    const drifted: SurfaceRule = { ...noDefault, kinds: ["namespace"] };
    expect(surfaceRulesFailingTheirProbe(compile([drifted]), NO_PARSER).map((r) => r.name)).toEqual(
      ["no-default-exports"],
    );
  });

  it("catches an allowlist that has widened to swallow its probe", () => {
    const widened: SurfaceRule = { ...publicNames, allow: ["^zz"] };
    expect(surfaceRulesFailingTheirProbe(compile([widened]), NO_PARSER).map((r) => r.name)).toEqual(
      ["public-names"],
    );
  });

  it("catches a count whose probe surface is now within bounds", () => {
    const loosened: SurfaceRule = { ...oneHandler, count: { min: 0, max: 5 } };
    expect(
      surfaceRulesFailingTheirProbe(compile([loosened]), NO_PARSER).map((r) => r.name),
    ).toEqual(["one-handler"]);
  });

  describe("with a source", () => {
    const DEFAULTED = "export default function main() {}";

    const parser = makeFactExtractorFake({
      [DEFAULTED]: {
        exportSites: [
          { file: "", name: "default", kind: "default", declares: "function", reexport: false },
        ],
      },
    });

    it("passes when the parser reads a site the rule reports", () => {
      const sourced: SurfaceRule = { ...noDefault, probe: { from: HANDLER, source: DEFAULTED } };
      expect(surfaceRulesFailingTheirProbe(compile([sourced]), parser)).toEqual([]);
    });

    it("fails when the parser reads nothing the rule reports", () => {
      const sourced: SurfaceRule = {
        ...noDefault,
        probe: { from: HANDLER, source: "const x = 1;" },
      };

      expect(surfaceRulesFailingTheirProbe(compile([sourced]), parser).map((r) => r.name)).toEqual([
        "no-default-exports",
      ]);
    });
  });
});

describe("compileSurfaceRules", () => {
  it("refuses an uncompilable pattern rather than loading a rule that matches nothing", () => {
    const broken: SurfaceRule = { ...camel, convention: "^[unclosed" };
    const compiled = compileSurfaceRules([broken]);
    expect(Result.isFailure(compiled)).toBe(true);
  });
});
