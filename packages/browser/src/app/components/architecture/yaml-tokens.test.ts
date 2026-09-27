import { describe, expect, it } from "vitest";

import { START, tokenize, tokenizeLines } from "./yaml-tokens.js";

// The manifest's colours: tree keys apart from rule keys, prose apart from
// patterns, and a block scalar's lines held as prose until the indent returns.

const kinds = (line: string) =>
  tokenize(line, START)
    .tokens.filter((token) => token.text.trim() !== "")
    .map((token) => [token.kind, token.text.trim()]);

describe("tokenize", () => {
  it("tells a tree key from a rule key", () => {
    expect(kinds('"modules/{module}/":')).toEqual([
      ["path-key", '"modules/{module}/"'],
      ["punct", ":"],
    ]);
    expect(kinds("  imports:")).toEqual([
      ["key", "imports"],
      ["punct", ":"],
    ]);
    expect(kinds('"*.test.ts": {}')[0]).toEqual(["path-key", '"*.test.ts"']);
  });

  it("colours a list of globs, a flow mapping and a reference", () => {
    expect(kinds('  allow: ["@/platform/**", "~/contracts/**"]')).toEqual([
      ["key", "allow"],
      ["punct", ":"],
      ["punct", "["],
      ["string", '"@/platform/**"'],
      ["punct", ","],
      ["string", '"~/contracts/**"'],
      ["punct", "]"],
    ]);
    expect(kinds('"*.test.ts": { use: server-unit-test-file }')).toEqual([
      ["path-key", '"*.test.ts"'],
      ["punct", ":"],
      ["punct", "{"],
      ["key", "use"],
      ["punct", ":"],
      ["ref", "server-unit-test-file"],
      ["punct", "}"],
    ]);
    expect(kinds("  reset: true")).toContainEqual(["literal", "true"]);
    expect(kinds("  - match: '**/*.test.ts' # tests")).toEqual([
      ["punct", "-"],
      ["key", "match"],
      ["punct", ":"],
      ["string", "'**/*.test.ts'"],
      ["comment", "# tests"],
    ]);
  });

  it("holds a block scalar's lines as prose until the indent returns", () => {
    const lines = [
      "  message: >-",
      "    The module root admits: only aggregation files.",
      "",
      "    # not a comment",
      "  imports:",
    ];
    const tokens = tokenizeLines(lines);
    expect(tokens[0]?.map((token) => token.kind)).toContain("indicator");
    expect(tokens[1]).toEqual([{ kind: "text", text: lines[1] }]);
    expect(tokens[3]).toEqual([{ kind: "text", text: lines[3] }]);
    expect(tokens[4]?.find((token) => token.text === "imports")?.kind).toBe("key");
  });

  it("keeps a comment line whole", () => {
    expect(kinds("# ── modules/ ──")).toEqual([["comment", "# ── modules/ ──"]]);
  });

  it("loses no character", () => {
    const line = '    external: [effect, "@effect/sql-pg"]  # the driver';
    expect(
      tokenize(line, START)
        .tokens.map((token) => token.text)
        .join(""),
    ).toBe(line);
  });
});
