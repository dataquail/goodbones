import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { makeFactExtractorLive } from "@goodbones/typescript";
import { afterAll, describe, expect, it } from "vitest";

import { sourceFactsOf } from "./source-facts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

// Inside the package rather than the OS temp dir, for the same reason the config
// loader's fixtures are: Vitest resolves through its own module graph.
const scratch = path.resolve(here, "../.tmp-facts-tests");
mkdirSync(scratch, { recursive: true });

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

let counter = 0;
const factsFor = (source: string, extension = "ts") => {
  counter += 1;
  const file = `packages/cli/.tmp-facts-tests/fixture-${String(counter)}.${extension}`;
  writeFileSync(path.join(repoRoot, file), source);
  return sourceFactsOf(repoRoot, file, makeFactExtractorLive());
};

describe("specifiers", () => {
  // The form a regex cannot see. Eleven of these in packages/web were invisible
  // to the survey harness for several rounds, which is why the CLI parses.
  it("sees a side-effect import with no clause", () => {
    expect(factsFor(`import "server-only";`).specifiers).toEqual(["server-only"]);
  });

  it("sees every module-edge form", () => {
    const facts = factsFor(`
      import a from "m1";
      import { b } from "m2";
      import * as c from "m3";
      export { d } from "m4";
      export * from "m5";
      const e = await import("m6");
      import f = require("m7");
      const g = require("m8");
    `);
    expect([...facts.specifiers]).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]);
  });

  it("lists an edge once however many names cross it", () => {
    expect(factsFor(`import { a, b, c } from "m";`).specifiers).toEqual(["m"]);
  });
});

describe("bindings", () => {
  const bindings = (source: string, specifier: string) =>
    factsFor(source).bindings.get(specifier) ?? [];

  it("reads a named import by the name in the source module, and carries the local alias", () => {
    expect(bindings(`import { makeCommandBus as make } from "m";`, "m")).toEqual([
      { symbol: "makeCommandBus", kind: "named", local: "make" },
    ]);
  });

  it("distinguishes default from namespace from named", () => {
    expect(bindings(`import d, * as n from "m";`, "m")).toEqual([
      { symbol: "default", kind: "default", local: "d" },
      { symbol: "*", kind: "namespace", local: "n" },
    ]);
  });

  it("reads a re-export's source name", () => {
    expect(bindings(`export { a as b } from "m";`, "m")).toEqual([
      { symbol: "a", kind: "named", local: "a" },
    ]);
  });

  // A side-effect import is an edge with nothing crossing it: the import rules
  // still see the edge, the export rules have no name to judge.
  it("gives a side-effect import no bindings", () => {
    expect(bindings(`import "m";`, "m")).toEqual([]);
  });

  it("reads a string-literal import name", () => {
    expect(bindings(`import { "a-b" as ab } from "m";`, "m")).toEqual([
      { symbol: "a-b", kind: "named", local: "ab" },
    ]);
  });
});

describe("whole-module bindings", () => {
  const whole = [{ symbol: "*", kind: "namespace" }];

  it.each([
    ['export * from "m";', "export *"],
    ['export * as ns from "m";', "export * as"],
    ['import x = require("m");', "import ="],
    ['const m = await import("m");', "import()"],
    ['const m = require("m");', "require()"],
  ])("%s carries the whole module, as `import * as` does", (source) => {
    expect(factsFor(source).bindings.get("m")).toMatchObject(whole);
  });

  it("a side-effect import carries nothing", () => {
    expect(factsFor('import "m";').bindings.get("m")).toEqual([]);
  });
});

describe("export sites", () => {
  const surface = (source: string) =>
    factsFor(source).exportSites.map(
      (site) => `${site.kind}:${site.name}:${site.declares}${site.reexport ? ":re" : ""}`,
    );

  it("reads a declaration's exported names with what they were declared as", () => {
    expect(surface(`export const a = 1, b = 2; export function f() {} export class C {}`)).toEqual([
      "named:a:variable",
      "named:b:variable",
      "named:f:function",
      "named:C:class",
    ]);
  });

  it("names a local export by its exported name, and looks up what it declares", () => {
    expect(surface(`function f() {} export { f as g, f as default };`)).toEqual([
      "named:g:function",
      "default:default:function",
    ]);
  });

  it("reads a default export's declaration, or `expression` when it has none", () => {
    expect(surface(`export default function () {}`)).toEqual(["default:default:function"]);
    expect(surface(`export default 1 + 1;`)).toEqual(["default:default:expression"]);
    expect(surface(`const x = 1; export default x;`)).toEqual(["default:default:variable"]);
  });

  it("reads a re-export as `other`, since its declaration is elsewhere", () => {
    expect(
      surface(`export { a, b as c } from "m"; export * from "m"; export * as n from "m";`),
    ).toEqual([
      "named:a:other:re",
      "named:c:other:re",
      "namespace:*:other:re",
      "namespace:n:other:re",
    ]);
  });

  it("reads the top level only — an export inside a namespace is not the module's", () => {
    expect(
      surface(`namespace N { export const inner = 1; } export namespace M { export const y = 2; }`),
    ).toEqual(["named:M:other"]);
  });

  it("does not read `export =` — a CommonJS surface", () => {
    expect(surface(`const x = 1; export = x;`)).toEqual([]);
  });
});

describe("member sites", () => {
  it("reads the members of a type alias, and the alias they sit in", () => {
    expect(
      factsFor(`type XRepositoryShape = { readonly findOneById: () => void };`).memberSites,
    ).toEqual([
      expect.objectContaining({
        subject: "members",
        name: "findOneById",
        in: "XRepositoryShape",
        declares: "type",
      }),
    ]);
  });

  it("reads a method signature as well as a property one", () => {
    const names = factsFor(`type X = { a: () => void; b(): void };`).memberSites.map(
      (site) => site.name,
    );
    expect(names).toEqual(["a", "b"]);
  });

  // A computed key is not a name a vocabulary rule can speak about.
  it("skips a computed key", () => {
    expect(factsFor(`const k = "x"; type X = { [k]: string };`).memberSites).toEqual([]);
  });

  it("reads a called identifier and a called member", () => {
    const names = factsFor(`useState(0); React.useEffect(fn);`).memberSites.map(
      (site) => site.name,
    );
    expect(names).toEqual(expect.arrayContaining(["useState", "useEffect"]));
  });

  it("reads calls inside JSX", () => {
    const names = factsFor(
      `export const V = () => <div>{useState(0)}</div>;`,
      "tsx",
    ).memberSites.map((site) => site.name);
    expect(names).toContain("useState");
  });
});

describe("declaration shapes", () => {
  const declared = (source: string) =>
    factsFor(source).memberSites.map((site) => `${site.in ?? ""}.${site.name}`);

  it("reads an interface's own members, and not the ones it extends", () => {
    expect(declared(`interface A { a(): void } interface B extends A { b(): void }`)).toEqual([
      "A.a",
      "B.b",
    ]);
  });

  it("reads the literal half of an intersection under the alias's own name", () => {
    expect(declared(`type Base = { a(): void }; type Port = Base & { b(): void };`)).toEqual([
      "Base.a",
      "Port.b",
    ]);
  });

  it("reads every constituent of a union", () => {
    expect(declared(`type E = { left(): void } | { right(): void };`)).toEqual([
      "E.left",
      "E.right",
    ]);
  });

  it("reads through parentheses", () => {
    expect(declared(`type P = ({ a(): void } & { b(): void });`)).toEqual(["P.a", "P.b"]);
  });

  it("does not follow a reference — its members are declared where it is", () => {
    expect(declared(`type Base = { a(): void }; type Port = Base;`)).toEqual(["Base.a"]);
  });

  it("steps over an interface's call and construct signatures", () => {
    expect(declared(`interface F { (x: number): void; new (x: number): F; own(): void }`)).toEqual([
      "F.own",
    ]);
  });

  it("reads a class body as a declaration, under the class's name", () => {
    expect(declared(`class K { k(): void {} }`)).toEqual(["K.k"]);
    expect(factsFor(`class K { k(): void {} }`).memberSites.map((site) => site.declares)).toEqual([
      "class",
    ]);
  });

  it("steps over a class's constructor, private members and computed keys", () => {
    expect(
      declared(
        `declare const key: string; class K { constructor() {} #p(): void {} [key]: string; q = 1; }`,
      ),
    ).toEqual(["K.q"]);
  });

  it("does not read an anonymous class or a class expression", () => {
    expect(declared(`export default class { k(): void {} }`)).toEqual([]);
    expect(declared(`const K = class { k(): void {} };`)).toEqual([]);
  });
});

describe("members the reader steps over", () => {
  it("reads a string-literal member name and the alias it sits in", () => {
    expect(factsFor(`type X = { "find-one": () => void };`).memberSites).toEqual([
      expect.objectContaining({ name: "find-one", in: "X" }),
    ]);
  });

  it("skips an index signature, which names nothing a vocabulary rule can speak about", () => {
    expect(factsFor(`type X = { [key: string]: () => void };`).memberSites).toEqual([]);
  });

  it("skips a call whose callee is neither an identifier nor a member", () => {
    expect(factsFor(`(() => 1)();`).memberSites).toEqual([]);
  });
});
