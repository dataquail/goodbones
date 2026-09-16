import { describe, expect, it } from "vitest";

import { astGrepMatcher } from "./matcher.js";

const matcher = astGrepMatcher();

const parse = (text: string, file = "src/a.tsx") => {
  const tree = matcher.parse(file, text);
  if (tree === null) throw new Error(`no grammar for ${file}`);
  return tree;
};

describe("astGrepMatcher", () => {
  it("parses by extension, and has no grammar for anything else", () => {
    expect(matcher.parse("a.ts", "let x = 1;")).not.toBeNull();
    expect(matcher.parse("a.tsx", "let x = <div />;")).not.toBeNull();
    expect(matcher.parse("a.js", "let x = 1;")).not.toBeNull();
    expect(matcher.parse("a.go", "package main")).toBeNull();
  });

  it("matches a pattern, with what each metavariable captured", () => {
    const tree = parse(
      "import { Component } from 'react';\nexport class Foo extends Component { render() { return null; } }",
    );
    const matches = tree.findAll({ pattern: "class $NAME extends $BASE { $$$ }" });
    expect(
      matches.map((one) => [one.captures.get("NAME"), one.captures.get("BASE"), one.anchor]),
    ).toEqual([["Foo", "Component", "Foo"]]);
    expect(matches[0]?.range).toEqual({
      start: { line: 1, column: 7 },
      end: { line: 1, column: 64 },
    });
  });

  // One rule per ast-grep rule kind, so a rename upstream fails here.
  it("passes every rule form through: kind, regex, has, inside, all, any, not, nthChild", () => {
    const tree = parse("function a() { b(); }\nconst c = () => { useState(); };\nuseEffect();");
    const texts = (rule: unknown) => tree.findAll(rule).map((one) => one.text);
    expect(texts({ kind: "call_expression" })).toEqual(["b()", "useState()", "useEffect()"]);
    expect(texts({ kind: "call_expression", regex: "^use" })).toEqual([
      "useState()",
      "useEffect()",
    ]);
    expect(texts({ kind: "function_declaration", has: { pattern: "b()", stopBy: "end" } })).toEqual(
      ["function a() { b(); }"],
    );
    expect(texts({ pattern: "$F()", inside: { kind: "arrow_function", stopBy: "end" } })).toEqual([
      "useState()",
    ]);
    expect(texts({ all: [{ kind: "call_expression" }, { regex: "Effect" }] })).toEqual([
      "useEffect()",
    ]);
    expect(texts({ any: [{ pattern: "b()" }, { pattern: "useEffect()" }] })).toEqual([
      "b()",
      "useEffect()",
    ]);
    expect(texts({ kind: "call_expression", not: { regex: "^use" } })).toEqual(["b()"]);
    expect(texts({ kind: "call_expression", nthChild: 1 })).toEqual([
      "b()",
      "useState()",
      "useEffect()",
    ]);
  });

  it("anchors a match on the nearest enclosing named declaration of every kind", () => {
    const tree = parse(
      [
        "class C { m() { hit(1); } }",
        "abstract class AC { p = hit(2); }",
        "function f() { hit(3); }",
        "function* g() { hit(4); }",
        "const v = () => { hit(5); };",
        "type T = ReturnType<typeof hit>;",
        "interface I { p: typeof hit }",
        "enum E { A = hit(8) }",
        "namespace N { hit(9); }",
        "hit(10);",
      ].join("\n"),
      "src/a.ts",
    );
    const anchors = tree
      .findAll({ pattern: "hit($N)" })
      .map((one) => [one.captures.get("N"), one.anchor]);
    expect(anchors).toEqual([
      ["1", "m"],
      ["2", "AC"],
      ["3", "f"],
      ["4", "g"],
      ["5", "v"],
      ["8", "E"],
      ["9", "N"],
      ["10", null],
    ]);
    expect(tree.findAll({ kind: "type_alias_declaration" }).map((one) => one.anchor)).toEqual([
      "T",
    ]);
    expect(tree.findAll({ kind: "interface_declaration" }).map((one) => one.anchor)).toEqual(["I"]);
  });

  it("anchors a declaration match on its own name", () => {
    const tree = parse("export function f() {}\nexport const v = 1;");
    expect(tree.findAll({ kind: "function_declaration" }).map((one) => one.anchor)).toEqual(["f"]);
    expect(tree.findAll({ kind: "variable_declarator" }).map((one) => one.anchor)).toEqual(["v"]);
  });

  it("anchors a position on the innermost named declaration containing it", () => {
    const tree = parse(
      [
        "export function outer() {",
        "  const inner = () => {",
        "    return 1;",
        "  };",
        "  return inner;",
        "}",
        "const top = 1;",
        "",
      ].join("\n"),
      "src/a.ts",
    );
    expect(tree.anchorAt({ line: 2, column: 4 })).toBe("inner");
    expect(tree.anchorAt({ line: 4, column: 2 })).toBe("outer");
    expect(tree.anchorAt({ line: 6, column: 8 })).toBe("top");
    expect(tree.anchorAt({ line: 7, column: 0 })).toBeNull();
    // A JavaScript file has no type aliases in its grammar, and anchors regardless.
    const js = parse("function f() { return 1; }", "src/a.js");
    expect(js.anchorAt({ line: 0, column: 16 })).toBe("f");
  });

  it("refuses a rule the engine cannot read, with the engine's own sentence", () => {
    const tree = parse("let x = 1;");
    expect(() => tree.findAll({ kind: "nonsense_kind" })).toThrow(/invalid/i);
    expect(() => tree.findAll({})).toThrow(/positive matcher/);
    expect(() => tree.findAll("pattern")).toThrow(/object of ast-grep rule keys/);
  });

  it("reads a file that does not parse as the nodes it could recover", () => {
    const tree = parse("let x = ;\nuseState();");
    expect(tree.findAll({ pattern: "useState()" }).length).toBe(1);
  });
});
