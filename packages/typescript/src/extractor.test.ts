import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { factsOfText, readProgram, sourceFactsOf } from "./extractor.js";

// The parity suite in `@goodbones/oxlint` is the extractor's largest test: it
// pins every form the reader reads against oxlint's parse of the same source.
// What is tested here is what that suite cannot reach — the parse itself, the
// node each fact carries, and the shapes the compiler API named differently
// from ESTree, so that the move between parsers is visible in one place.

describe("factsOfText", () => {
  it("reads the whole-module forms ESTree names differently from the compiler", () => {
    // `ImportExpression`, `TSExternalModuleReference`, `TSAbstractMethodDefinition`,
    // `TSExportAssignment` — one each, under the names oxc gives them.
    const facts = factsOfText(
      "x.ts",
      [
        'const lazy = await import("dynamic");',
        'import legacy = require("equals");',
        "export abstract class Port { abstract run(): void; abstract name: string; }",
        "export = Port;",
      ].join("\n"),
    );
    expect(facts.specifiers).toEqual(["dynamic", "equals"]);
    expect(facts.bindings.get("dynamic")).toEqual([{ symbol: "*", kind: "namespace" }]);
    expect(facts.bindings.get("equals")).toEqual([{ symbol: "*", kind: "namespace" }]);
    expect(facts.memberSites.filter((site) => site.subject === "members")).toEqual([
      { file: "x.ts", subject: "members", name: "run", in: "Port", declares: "class" },
      { file: "x.ts", subject: "members", name: "name", in: "Port", declares: "class" },
    ]);
    // `export =` is not the module's surface; the class is.
    expect(facts.exportSites.map((site) => `${site.kind}:${site.name}`)).toEqual(["named:Port"]);
  });

  it("does not follow a type reference, a parenthesised type or not", () => {
    const facts = factsOfText(
      "x.ts",
      "type Base = { fromBase(): void };\ntype T = Base & ({ inParens(): void } | Base);",
    );
    expect(facts.memberSites.map((site) => `${site.in ?? ""}.${site.name}`)).toEqual([
      "Base.fromBase",
      "T.inParens",
    ]);
  });

  it("names a call through parentheses, as the parser keeps none", () => {
    const facts = factsOfText("x.ts", "declare const x: { f(): void };\n(x.f)();\n(x).f();");
    expect(facts.memberSites.map((site) => site.name)).toEqual(["f", "f"]);
  });

  it("parses .tsx as TSX and every other extension as TypeScript", () => {
    const view = factsOfText(
      "view.tsx",
      'import { useThing } from "hooks";\nexport const V = () => <div onClick={() => useThing()} />;',
    );
    expect(view.specifiers).toEqual(["hooks"]);
    expect(view.memberSites.map((site) => site.name)).toEqual(["useThing"]);
    expect(view.exportSites.map((site) => site.name)).toEqual(["V"]);

    // `.cts` and `.mts` carry the same syntax; a probe's `from` may carry no
    // extension at all and still reads as TypeScript.
    const cjs = factsOfText("mod.cts", 'import x = require("m");\nexport = x;');
    expect(cjs.specifiers).toEqual(["m"]);
    expect(cjs.exportSites).toEqual([]);
    const esm = factsOfText("mod.mts", 'export * as ns from "m";');
    expect(esm.exportSites.map((site) => `${site.kind}:${site.name}`)).toEqual(["namespace:ns"]);
    const bare = factsOfText("probe", "export type Port = { run(): void };");
    expect(bare.memberSites.map((site) => site.name)).toEqual(["run"]);
  });

  it("reads a file that does not parse as one with no facts, and does not throw", () => {
    // oxc reports a syntax error and returns an empty program rather than a
    // partial tree, so a file that does not parse contributes nothing.
    const facts = factsOfText("x.ts", 'import { a } from "m";\nconst x = ;\n');
    expect(facts.specifiers).toEqual([]);
    expect(facts.exportSites).toEqual([]);
  });

  it("lists a specifier once however many times it is written, with every binding", () => {
    const facts = factsOfText("x.ts", 'import { a } from "m";\nimport { b } from "m";');
    expect(facts.specifiers).toEqual(["m"]);
    expect(facts.bindings.get("m")).toEqual([
      { symbol: "a", kind: "named" },
      { symbol: "b", kind: "named" },
    ]);
  });
});

describe("readProgram", () => {
  const source = [
    'import def, { a, b as c } from "m";',
    'export * as ns from "n";',
    "export type Port = { run(): void };",
    "export const x = 1;",
    "run();",
  ].join("\n");
  const { program } = parseSync("x.ts", source, { preserveParens: false });
  const read = readProgram("x.ts", program);

  it("carries every edge as written, with the node and each binding's local name", () => {
    expect(read.edges.map((edge) => [edge.specifier, edge.form, edge.node.type])).toEqual([
      ["m", "import", "ImportDeclaration"],
      ["n", "export", "ExportAllDeclaration"],
    ]);
    expect(read.edges[0]?.bindings.map((one) => [one.symbol, one.kind, one.local])).toEqual([
      ["default", "default", "def"],
      ["a", "named", "a"],
      ["b", "named", "c"],
    ]);
    expect(read.edges[1]?.bindings.map((one) => [one.symbol, one.local])).toEqual([["*", "ns"]]);
  });

  it("carries a member at its key and a call at the call", () => {
    expect(read.memberSites.map((site) => [site.name, site.subject, site.node.type])).toEqual([
      ["run", "members", "Identifier"],
      ["run", "calls", "CallExpression"],
    ]);
  });

  it("carries an export at the declaration or specifier that made it", () => {
    expect(read.exportSites.map((site) => [site.name, site.node.type])).toEqual([
      ["ns", "ExportAllDeclaration"],
      ["Port", "TSTypeAliasDeclaration"],
      ["x", "VariableDeclaration"],
    ]);
  });

  it("strips to the facts the core sees", () => {
    expect(sourceFactsOf(read)).toEqual(factsOfText("x.ts", source));
    for (const site of sourceFactsOf(read).memberSites) expect(site).not.toHaveProperty("node");
  });
});
