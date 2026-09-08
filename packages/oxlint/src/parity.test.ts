import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileExportRules,
  compileImportRules,
  compileMemberRules,
  compileSurfaceRules,
  EMPTY_BASELINE,
  EMPTY_GRAPH_RULES,
  EMPTY_STRUCTURE,
  evaluateMemberSite,
  evaluateSelectedBindings,
  evaluateSelectedEdge,
  evaluateSurface,
  exportRulesSelecting,
  formatMessage,
  type LoadedPolicy,
  makeBaselineFilter,
  memberRulesSelecting,
  rulesSelecting,
  surfaceRulesSelecting,
} from "@goodbones/core";
import {
  makeFactExtractorFake,
  makeFileSystemFake,
  makeModuleResolverFake,
} from "@goodbones/core/testing";
import { factsOfText } from "@goodbones/typescript";
import * as Result from "effect/Result";
import { RuleTester } from "oxlint/plugins-dev";
import { describe, expect, it } from "vitest";

import { makeExportsRule } from "./exports-rule.js";
import { makeImportsRule } from "./imports-rule.js";
import { makeMembersRule } from "./members-rule.js";
import { makeSurfaceRule } from "./surface-rule.js";

RuleTester.describe = describe;
RuleTester.it = it;

// The two adapters read facts out of two different syntax trees and claim to
// meet at one vocabulary. This suite is that claim, tested: every snippet below
// is parsed by TypeScript through the CLI's extractor, the facts it yields are
// turned into the diagnostics a rule that fires on *everything* would produce,
// and the oxlint rule is then required to produce exactly those diagnostics
// from the same snippet.
//
// A form one adapter sees and the other does not fails here, not in a user's
// CI as a policy that holds under `architecture check` and not under `oxlint`.
// A form both are blind to — `interface`, a class body — passes; widening one
// adapter without the other is the failure this exists to catch.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Fixture = { readonly file: string; readonly code: string };

const CORPUS: ReadonlyArray<Fixture> = [
  {
    // Every syntactic form that names a module, with and without bindings —
    // and, at the end, the two computed forms neither adapter can read.
    file: "parity/edges.ts",
    code: `
import "side-effect";
import def from "default-only";
import * as ns from "namespace-only";
import mixed, { a, b as c, "string-name" as d } from "mixed-bindings";
import type { T } from "type-only";
export { e, f as g } from "reexport-named";
export * from "reexport-all";
export * as h from "reexport-namespace";
import legacy = require("import-equals");
const lazy = await import("dynamic-literal");
const cjs = require("require-literal");
export { def, ns, mixed, c, d, legacy, lazy, cjs };
export const local = 1;
export { local as aliased };
declare const which: string;
const notAnEdge1 = await import(\`dynamic-\${which}\`);
const notAnEdge2 = require(which);
export { notAnEdge1, notAnEdge2 };
`,
  },
  {
    // Every way a name can be called, and the three ways a call has no name a
    // vocabulary rule can speak about.
    file: "parity/calls.ts",
    code: `
declare const x: { f(): void; y: { f(): void }; F: new () => void; [k: string]: unknown };
declare const f: (...args: Array<unknown>) => void;
declare const g: () => void;
declare const key: string;
f();
x.f();
x.y.f();
x?.f();
f(g());
x[key]();
x["f"]();
new x.F();
class C {
  #p(): void {}
  run(): void {
    this.#p();
  }
}
export { C };
`,
  },
  {
    // Every declaration shape a port might take — the ones both adapters read,
    // and the ones both step over, so that reading a new one is a change to
    // both adapters or to neither.
    file: "parity/type-members.ts",
    code: `
export type Alias = {
  a: string;
  b(): void;
  "c-d": number;
  [k: string]: unknown;
  1: boolean;
  readonly e?: string;
};
export interface Iface extends Alias {
  own(): void;
  (call: number): void;
  new (construct: number): Iface;
}
type Base = { fromBase(): void };
export type Intersected = Base & { fromIntersection(): void };
export type Union = { fromLeft(): void } | { fromRight(): void };
export type Nested = Base & ({ fromParens(): void } | Alias);
export type Generic<T> = { g: T };
export type Referenced = Base;
export class K {
  k(): void {}
}
export type Fn = () => void;
export type Mapped = { [K in "a"]: string };
`,
  },
  {
    // Every member shape a class body can carry — the ones both adapters read
    // under the class's name, and the ones both step over: a constructor, a
    // private `#name`, a computed key, an index signature, and the two
    // shapes that are not a named class declaration at all.
    file: "parity/class-members.ts",
    code: `
declare const key: string;
export class Live {
  a: string = "";
  b(): void {}
  get c(): number { return 1; }
  set c(value: number) {}
  static d(): void {}
  "e-f"(): void {}
  readonly g?: number;
  #h(): void {}
  [key]: string;
  [index: string]: unknown;
  constructor() {}
}
export abstract class Port {
  abstract i(): void;
  abstract j: string;
}
export default class {
  k(): void {}
}
export const L = class { m(): void {} };
`,
  },
  {
    // Every way a file can offer a name, and the two forms that are not the
    // module's surface: an `export` inside a namespace, and `export =`.
    file: "parity/surface.ts",
    code: `
export const a = 1, b = 2;
export let { c, d: [e] } = { c: 1, d: [2] };
export function f() {}
export class C {}
export type T = string;
export interface I { x: number }
export enum E { A }
export namespace Exported { export const inner = 1; }
const local = 1;
type LocalT = number;
export { local, LocalT as Renamed };
export type { T as TT };
export default class Main {}
export { r1, r2 as r3 } from "reexport-named";
export * from "reexport-all";
export * as ns from "reexport-namespace";
namespace Hidden { export const notSurface = 1; }
`,
  },
  {
    // The same forms parse under the TSX grammar.
    file: "parity/view.tsx",
    code: `
import { useThing } from "hooks";
declare const useState: (n: number) => void;
export const V = () => <div onClick={() => useThing()} />;
useState(0);
`,
  },
];

// Rules that fire on every fact of their family, so the diagnostics are the
// facts. `{name}` puts the subject in the message, which is what makes two
// diagnostics comparable.
const config = {
  resolve: {
    scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.resolve.json" } }],
  },
  imports: [
    {
      name: "every-edge",
      message: "edge to {name}",
      probe: { from: "parity/edges.ts", to: "lib/side-effect.ts" },
      from: "^parity/",
    },
  ],
  exports: [
    {
      name: "every-binding",
      message: "binding {name}",
      probe: { from: "parity/edges.ts", to: "lib/default-only.ts", symbol: "default" },
      from: "^parity/",
      to: "^lib/",
      kinds: ["named", "default", "namespace"] as const,
    },
  ],
  surface: [
    {
      name: "every-export",
      message: "export {name}",
      probe: { from: "parity/surface.ts", sites: [{ name: "a", kind: "named" as const }] },
      from: "^parity/",
    },
  ],
  members: [
    {
      name: "every-call",
      message: "call {name}",
      probe: { from: "parity/calls.ts", name: "f" },
      from: "^parity/",
      subject: "calls" as const,
    },
    {
      name: "every-member",
      message: "member {name}",
      probe: { from: "parity/type-members.ts", name: "a", in: "Alias" },
      from: "^parity/",
      subject: "members" as const,
    },
  ],
};

const unwrap = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

const cliFacts = CORPUS.map((fixture) => ({
  fixture,
  facts: factsOfText(fixture.file, fixture.code),
}));

// Every specifier the CLI found resolves somewhere. One the plugin finds and the
// CLI did not therefore surfaces as an unresolved-import diagnostic — still a
// count mismatch, still a failure.
const resolver = makeModuleResolverFake(
  Object.fromEntries(
    cliFacts.flatMap(({ facts }) => facts.specifiers.map((one) => [one, `lib/${one}.ts`])),
  ),
);

const policy: LoadedPolicy = {
  repoRoot,
  config: { resolve: config.resolve, tree: {} },
  importRules: unwrap(compileImportRules(config.imports)),
  exportRules: unwrap(compileExportRules(config.exports)),
  memberRules: unwrap(compileMemberRules(config.members)),
  surfaceRules: unwrap(compileSurfaceRules(config.surface)),
  graph: EMPTY_GRAPH_RULES,
  adoption: { unrestricted: [], partial: [] },
  nodes: [],
  structure: EMPTY_STRUCTURE,
  fileSystem: makeFileSystemFake([]),
  languages: [],
  extractor: makeFactExtractorFake({}),
  resolver,
  ignoreUnresolved: [],
  notices: [],
  baseline: makeBaselineFilter(EMPTY_BASELINE),
};

type Expected = (fixture: Fixture, facts: (typeof cliFacts)[number]["facts"]) => Array<string>;

const expectedImports: Expected = (fixture, facts) => {
  const selected = rulesSelecting(policy.importRules, fixture.file);
  return facts.specifiers.flatMap((specifier) =>
    unwrap(evaluateSelectedEdge(selected, resolver, { importer: fixture.file, specifier })).map(
      formatMessage,
    ),
  );
};

const expectedExports: Expected = (fixture, facts) => {
  const selected = exportRulesSelecting(policy.exportRules, fixture.file);
  return facts.specifiers.flatMap((specifier) =>
    unwrap(
      evaluateSelectedBindings(selected, resolver, {
        importer: fixture.file,
        specifier,
        bindings: facts.bindings.get(specifier) ?? [],
      }),
    ).map(({ violation }) => formatMessage(violation)),
  );
};

const expectedMembers: Expected = (fixture, facts) => {
  const selected = memberRulesSelecting(policy.memberRules, fixture.file);
  return facts.memberSites.flatMap((site) => evaluateMemberSite(selected, site).map(formatMessage));
};

const expectedSurface: Expected = (fixture, facts) =>
  evaluateSurface(
    surfaceRulesSelecting(policy.surfaceRules, fixture.file),
    fixture.file,
    facts.exportSites,
  ).map(formatMessage);

const casesFor = (expected: Expected) => {
  const valid: Array<{ code: string; filename: string }> = [];
  const invalid: Array<{ code: string; filename: string; errors: Array<{ message: string }> }> = [];
  for (const { facts, fixture } of cliFacts) {
    const filename = path.join(repoRoot, fixture.file);
    const messages = expected(fixture, facts);
    if (messages.length === 0) valid.push({ code: fixture.code, filename });
    else {
      invalid.push({
        code: fixture.code,
        filename,
        errors: messages.map((message) => ({ message })),
      });
    }
  }
  return { valid, invalid };
};

new RuleTester({ cwd: repoRoot }).run(
  "parity: imports",
  makeImportsRule(policy),
  casesFor(expectedImports),
);
new RuleTester({ cwd: repoRoot }).run(
  "parity: exports",
  makeExportsRule(policy),
  casesFor(expectedExports),
);
new RuleTester({ cwd: repoRoot }).run(
  "parity: members",
  makeMembersRule(policy),
  casesFor(expectedMembers),
);
new RuleTester({ cwd: repoRoot }).run(
  "parity: surface",
  makeSurfaceRule(policy),
  casesFor(expectedSurface),
);

// The suites above only prove the plugin agrees with the CLI. This pins what
// the CLI itself reads, so the corpus cannot quietly stop exercising a form —
// if both adapters lost `require`, the parity suites would still pass.
describe("the corpus exercises every form", () => {
  const facts = (file: string) => {
    const found = cliFacts.find((one) => one.fixture.file === file);
    if (found === undefined) throw new Error(`no fixture ${file}`);
    return found.facts;
  };

  it("reads every edge form, and neither computed one", () => {
    expect(facts("parity/edges.ts").specifiers).toEqual([
      "side-effect",
      "default-only",
      "namespace-only",
      "mixed-bindings",
      "type-only",
      "reexport-named",
      "reexport-all",
      "reexport-namespace",
      "import-equals",
      "dynamic-literal",
      "require-literal",
    ]);
  });

  it("reads every binding form", () => {
    const bindings = facts("parity/edges.ts").bindings;
    expect(bindings.get("mixed-bindings")).toEqual([
      { symbol: "default", kind: "default" },
      { symbol: "a", kind: "named" },
      { symbol: "b", kind: "named" },
      { symbol: "string-name", kind: "named" },
    ]);
    expect(bindings.get("namespace-only")).toEqual([{ symbol: "*", kind: "namespace" }]);
    expect(bindings.get("reexport-named")).toEqual([
      { symbol: "e", kind: "named" },
      { symbol: "f", kind: "named" },
    ]);
    expect(bindings.get("side-effect")).toEqual([]);
  });

  it("reads every whole-module form as one namespace binding", () => {
    const bindings = facts("parity/edges.ts").bindings;
    const whole = [{ symbol: "*", kind: "namespace" }];
    expect(bindings.get("reexport-all")).toEqual(whole);
    expect(bindings.get("reexport-namespace")).toEqual(whole);
    expect(bindings.get("import-equals")).toEqual(whole);
    expect(bindings.get("dynamic-literal")).toEqual(whole);
    expect(bindings.get("require-literal")).toEqual(whole);
  });

  it("names a call by its identifier or property, and not by a computed or private one", () => {
    const called = facts("parity/calls.ts")
      .memberSites.filter((site) => site.subject === "calls")
      .map((site) => site.name);
    expect(called).toEqual(["f", "f", "f", "f", "f", "g"]);
  });

  it("reads every export form, top level only", () => {
    const surface = facts("parity/surface.ts").exportSites.map(
      (site) => `${site.kind}:${site.name}:${site.declares}${site.reexport ? ":re-export" : ""}`,
    );
    expect(surface).toEqual([
      "named:a:variable",
      "named:b:variable",
      "named:c:variable",
      "named:e:variable",
      "named:f:function",
      "named:C:class",
      "named:T:type",
      "named:I:interface",
      "named:E:enum",
      "named:Exported:other",
      "named:local:variable",
      "named:Renamed:type",
      "named:TT:type",
      "default:default:class",
      "named:r1:other:re-export",
      "named:r3:other:re-export",
      "namespace:*:other:re-export",
      "namespace:ns:other:re-export",
    ]);
  });

  it("reads the members written in an alias, interface or class, and follows no reference", () => {
    const declared = facts("parity/type-members.ts")
      .memberSites.filter((site) => site.subject === "members")
      .map((site) => `${site.in ?? ""}.${site.name}:${site.declares ?? ""}`);
    expect(declared).toEqual([
      "Alias.a:type",
      "Alias.b:type",
      "Alias.c-d:type",
      "Alias.e:type",
      "Iface.own:interface",
      "Base.fromBase:type",
      "Intersected.fromIntersection:type",
      "Union.fromLeft:type",
      "Union.fromRight:type",
      "Nested.fromParens:type",
      "Generic.g:type",
      "K.k:class",
    ]);
  });

  it("reads a class body's named members, and none of the shapes without a name", () => {
    const declared = facts("parity/class-members.ts")
      .memberSites.filter((site) => site.subject === "members")
      .map((site) => `${site.in ?? ""}.${site.name}:${site.declares ?? ""}`);
    expect(declared).toEqual([
      "Live.a:class",
      "Live.b:class",
      "Live.c:class",
      "Live.c:class",
      "Live.d:class",
      "Live.e-f:class",
      "Live.g:class",
      "Port.i:class",
      "Port.j:class",
    ]);
  });
});
