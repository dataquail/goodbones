import { describe, expect, it } from "vitest";

import { DEFAULT_STATE, parseHash, selectionKey, serializeHash } from "./hash-state.js";

describe("the URL hash", () => {
  it("round-trips every field, so a view is a link", () => {
    const state = {
      mode: { kind: "folder" as const },
      focus: "packages/core/src",
      depth: 2 as const,
      designed: true,
      outside: false,
      selected: { kind: "edge" as const, from: "packages/core/src/core", to: "pkg:effect" },
    };
    const hash = serializeHash(state);
    expect(hash).toBe(
      "#focus=packages%2Fcore%2Fsrc&depth=2&designed&inside&select=edge%3Apackages%2Fcore%2Fsrc%2Fcore%7Cpkg%3Aeffect",
    );
    expect(parseHash(hash)).toEqual(state);
  });

  it("is empty for the defaults, and reads an empty hash as them", () => {
    expect(serializeHash(DEFAULT_STATE)).toBe("");
    expect(parseHash("")).toEqual(DEFAULT_STATE);
    expect(parseHash("#")).toEqual(DEFAULT_STATE);
  });

  it("reads a node selection, and ignores one it cannot", () => {
    expect(parseHash("#select=node%3Asrc%2Fa.ts").selected).toEqual({
      kind: "node",
      id: "src/a.ts",
    });
    expect(parseHash("#select=what").selected).toBeNull();
    expect(parseHash("#select=edge%3Anopipe").selected).toBeNull();
    expect(selectionKey({ kind: "node", id: "x" })).toBe("node:x");
  });

  it("round-trips a violation and a cycle selection", () => {
    const violation = {
      ...DEFAULT_STATE,
      selected: { kind: "violation" as const, fingerprint: "import|a|b.ts|c.ts" },
    };
    expect(parseHash(serializeHash(violation))).toEqual(violation);
    const cycle = { ...DEFAULT_STATE, selected: { kind: "cycle" as const, index: 3 } };
    expect(parseHash(serializeHash(cycle))).toEqual(cycle);
    expect(parseHash("#select=cycle%3Athree").selected).toBeNull();
  });

  it("round-trips the layer and slice modes, keeping the folder to go back to", () => {
    const layer = { ...DEFAULT_STATE, focus: "src", mode: { kind: "layer" as const, layer: "io" } };
    expect(serializeHash(layer)).toBe("#focus=src&layer=io");
    expect(parseHash(serializeHash(layer))).toEqual(layer);
    const slice = { ...DEFAULT_STATE, mode: { kind: "slice" as const, file: "src/a.ts" } };
    expect(parseHash(serializeHash(slice))).toEqual(slice);
    expect(parseHash("#layer=").mode).toEqual({ kind: "folder" });
  });

  it("drops a trailing slash from the focus a hand wrote", () => {
    expect(parseHash("#focus=src/").focus).toBe("src");
  });
});
