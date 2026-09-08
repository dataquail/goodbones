import { describe, expect, it } from "vitest";

import type { LoweredNode } from "../domain/architecture-config.js";
import { governingNode, nodesSelecting } from "./nodes.js";

// The shape lowering produces for `src/` holding `domain/` and a `*.ts` key,
// written flat.
const node = (
  path: string,
  name: string,
  parent: string | null,
  selector: string,
  kind: LoweredNode["kind"] = "folder",
): LoweredNode => ({
  path,
  name,
  parent,
  kind,
  selector,
  layout: kind === "folder" ? "open" : null,
  unrestricted: false,
  partial: false,
  families: [],
});

const NODES: ReadonlyArray<LoweredNode> = [
  node("src/", "src", null, "^src/"),
  node("src/domain/", "src/domain", "src", "^src/domain/"),
  node("src/*.ts", "src/*.ts", "src", "^src/[^/]*\\.ts$", "file"),
  node("src/**/", "src/**", "src", "^src/(?:.*/)?"),
];

describe("nodesSelecting", () => {
  it("answers deepest first, ties in manifest order", () => {
    expect(nodesSelecting(NODES, "src/domain/user.ts").map((one) => one.path)).toEqual([
      "src/domain/",
      "src/**/",
      "src/",
    ]);
  });

  it("puts a file key's node before its folder's", () => {
    expect(nodesSelecting(NODES, "src/index.ts").map((one) => one.path)).toEqual([
      "src/*.ts",
      "src/**/",
      "src/",
    ]);
  });

  it("answers nothing for a file the tree does not reach", () => {
    expect(nodesSelecting(NODES, "lib/x.ts")).toEqual([]);
    expect(governingNode(NODES, "lib/x.ts")).toBeNull();
  });

  it("names the governing node", () => {
    expect(governingNode(NODES, "src/domain/deep/x.ts")?.path).toBe("src/domain/");
  });
});
