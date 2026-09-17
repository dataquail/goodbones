import { describe, expect, it } from "vitest";

import { indexByFile, parseReport, uniqueDiagnostics } from "./report.js";

const repoRoot = "/repo";

describe("parseReport", () => {
  it("reads tsc's one-line-per-error output, positions made zero-based and paths repo-relative", () => {
    const text = [
      "src/a.ts(12,5): error TS2551: Property 'x' does not exist on type 'Y'. Did you mean 'z'?",
      "  Type 'A' is not assignable to type 'B'.",
      "/repo/src/b.ts(1,1): error TS18048: 'y' is possibly 'undefined'.",
      "error TS5042: Option 'project' cannot be mixed with source files on a command line.",
    ].join("\n");
    expect(parseReport("tsc", text, { repoRoot })).toEqual([
      {
        file: "src/a.ts",
        line: 11,
        column: 4,
        code: "TS2551",
        message: "Property 'x' does not exist on type 'Y'. Did you mean 'z'?",
      },
      {
        file: "src/b.ts",
        line: 0,
        column: 0,
        code: "TS18048",
        message: "'y' is possibly 'undefined'.",
      },
    ]);
  });

  it("reads eslint --format json", () => {
    const text = JSON.stringify([
      {
        filePath: "/repo/src/a.ts",
        messages: [
          {
            ruleId: "no-unused-vars",
            line: 2,
            column: 7,
            message: "'x' is defined but never used.",
          },
          { ruleId: null, line: 1, column: 1, message: "Parsing error" },
        ],
      },
    ]);
    expect(parseReport("eslint", text, { repoRoot })).toEqual([
      {
        file: "src/a.ts",
        line: 1,
        column: 6,
        code: "no-unused-vars",
        message: "'x' is defined but never used.",
      },
      { file: "src/a.ts", line: 0, column: 0, code: "", message: "Parsing error" },
    ]);
    expect(() => parseReport("eslint", "{}", { repoRoot })).toThrow(/JSON array/);
  });

  it("reads oxlint --format json", () => {
    const text = JSON.stringify({
      diagnostics: [
        {
          message: "`debugger` statement is not allowed",
          code: "eslint(no-debugger)",
          severity: "error",
          filename: "/repo/src/a.ts",
          labels: [{ span: { offset: 28, length: 9, line: 2, column: 16 } }],
        },
      ],
      number_of_files: 1,
    });
    expect(parseReport("oxlint", text, { repoRoot })).toEqual([
      {
        file: "src/a.ts",
        line: 1,
        column: 15,
        code: "eslint(no-debugger)",
        message: "`debugger` statement is not allowed",
      },
    ]);
    expect(() => parseReport("oxlint", "[]", { repoRoot })).toThrow(/diagnostics/);
    expect(() => parseReport("oxlint", "nope", { repoRoot })).toThrow(/does not parse/);
  });

  it("reads any line format through a regex with named groups", () => {
    const pattern = "^(?<file>[^:]+):(?<line>\\d+):(?<column>\\d+): (?<code>\\S+) (?<message>.*)$";
    const text =
      "src/a.go:3:2: SA1019 deprecated\nnot a finding\n./src/b.go:9:1: ST1000 no package comment";
    expect(parseReport("regex", text, { repoRoot, pattern })).toEqual([
      { file: "src/a.go", line: 2, column: 1, code: "SA1019", message: "deprecated" },
      { file: "src/b.go", line: 8, column: 0, code: "ST1000", message: "no package comment" },
    ]);
    expect(() => parseReport("regex", text, { repoRoot })).toThrow(/pattern/);
  });

  it("indexes by file", () => {
    const diagnostics = parseReport(
      "tsc",
      "src/a.ts(1,1): error TS1: a\nsrc/b.ts(1,1): error TS2: b\nsrc/a.ts(2,1): error TS3: c",
      { repoRoot },
    );
    const indexed = indexByFile(diagnostics);
    expect([...indexed.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(indexed.get("src/a.ts")?.map((one) => one.code)).toEqual(["TS1", "TS3"]);
  });

  it("keeps a diagnostic once when two outputs print it, and apart when anything differs", () => {
    const one = { file: "src/a.ts", line: 1, column: 1, code: "TS1", message: "a" };
    expect(
      uniqueDiagnostics([
        one,
        { ...one },
        { ...one, column: 2 },
        { ...one, code: "TS2" },
        { ...one, message: "b" },
        one,
      ]),
    ).toEqual([one, { ...one, column: 2 }, { ...one, code: "TS2" }, { ...one, message: "b" }]);
  });
});
