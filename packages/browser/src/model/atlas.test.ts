import { describe, expect, it } from "vitest";

import { type Atlas, buildAtlas } from "./atlas.js";
import { factsOf, FILES, loadFixture, locate, MANIFEST_TEXT } from "./fixture.test-helper.js";

// The Architecture Browser's data, against the fixture: which node governs
// each file, how each edge was judged and by what, where each node was
// written, and what nothing uses.

const atlasOf = (): Atlas => {
  const policy = loadFixture();
  return buildAtlas({
    policy,
    name: "repo",
    roots: ["svc"],
    files: FILES,
    factsOf,
    locate,
    manifestPath: "architecture.yaml",
    manifestFiles: [{ path: "architecture.yaml", text: MANIFEST_TEXT }],
    now: policy.now,
  });
};

describe("buildAtlas", () => {
  const atlas = atlasOf();
  const file = (path: string) => {
    const found = atlas.files.find((one) => one.path === path);
    if (found === undefined) throw new Error(`no file ${path}`);
    return found;
  };
  const node = (id: string) => {
    const found = atlas.manifest.nodes.find((one) => one.id === id);
    if (found === undefined) throw new Error(`no node ${id}`);
    return found;
  };
  const edge = (from: string, to: string) => {
    const found = atlas.edges.find((one) => one.from === from && one.to === to);
    if (found === undefined) throw new Error(`no edge ${from} → ${to}`);
    return found;
  };

  it("names each node as its rules do, so the two join", () => {
    const policy = loadFixture();
    const ruleNames = new Set(policy.importRules.map((rule) => rule.name));
    for (const one of atlas.manifest.nodes) {
      if (one.imports !== null) expect(ruleNames.has(`${one.id}/imports`)).toBe(true);
    }
    expect(atlas.manifest.nodes.map((one) => one.id)).toEqual([
      "svc",
      "svc/main.go",
      "svc/domain",
      "svc/domain/*.go",
      "svc/adapters",
      "svc/adapters/*.go",
    ]);
    expect(node("svc/domain").rules).toEqual(["svc/domain/imports", "svc/domain/layout"]);
    expect(node("svc/domain/*.go").rules).toEqual(["svc/domain/*.go/requires"]);
  });

  it("governs each file by the deepest node whose path covers it", () => {
    expect(file("svc/domain/repo.go").chain).toEqual(["svc", "svc/domain", "svc/domain/*.go"]);
    expect(file("svc/main.go").chain).toEqual(["svc", "svc/main.go"]);
    expect(file("svc/adapters/pg.go").node).toBe("svc/adapters/*.go");
    expect(node("svc/domain/*.go").files).toBe(2);
    expect(node("svc").files).toBe(0);
  });

  it("carries where each node was written", () => {
    expect(node("svc").position).toEqual({ file: "architecture.yaml", line: 6, column: 1 });
    expect(node("svc/domain/*.go").position).toEqual({
      file: "architecture.yaml",
      line: 19,
      column: 1,
    });
    expect(atlas.manifest.rules).toEqual([
      {
        family: "cycles",
        name: "no-cycles",
        message: "A cycle.",
        position: { file: "architecture.yaml", line: 1, column: 1 },
      },
    ]);
    expect(atlas.manifest.files[0]?.text).toBe(MANIFEST_TEXT);
  });

  it("judges each edge and names the allowance that admitted it", () => {
    expect(edge("svc/main.go", "svc/domain/repo.go")).toMatchObject({
      status: "allowed",
      admittedBy: { node: "svc", entry: "svc/**", fragment: null },
      specifiers: ["svc/domain/repo"],
    });
    expect(edge("svc/adapters/pg.go", "svc/domain/repo.go").admittedBy).toEqual({
      node: "svc/adapters",
      entry: "svc/domain/**",
      fragment: null,
    });
    const refused = edge("svc/adapters/pg.go", "svc/main.go");
    expect(refused.status).toBe("refused");
    expect(refused.admittedBy).toBeNull();
    expect(refused.refusedBy.map((one) => one.rule)).toEqual(["svc/adapters/imports"]);
    expect(refused.refusedBy[0]?.message).toContain("adapters reach the domain");
  });

  it("keeps externals and builtins on the file, judged the same way", () => {
    expect(file("svc/main.go").externals).toEqual([
      {
        package: "pq",
        specifiers: ["pq"],
        status: "allowed",
        admittedBy: { node: "svc", entry: "pq" },
      },
    ]);
    expect(file("svc/main.go").builtins).toEqual(["os"]);
  });

  it("keeps a target outside the walk as a file for the edge to land on", () => {
    expect(file("vendor.go")).toMatchObject({ walked: false, node: null, chain: [] });
    // Outside `svc/**`, so the allowlist refuses it — and the edge still lands.
    expect(edge("svc/main.go", "vendor.go")).toMatchObject({
      status: "refused",
      refusedBy: [{ rule: "svc/imports" }],
    });
    expect(atlas.folders.map((one) => one.path)).toEqual(["svc", "svc/adapters", "svc/domain"]);
    expect(atlas.folders[0]).toMatchObject({ node: "svc", declares: ["svc"], parent: null });
    expect(atlas.folders[2]).toMatchObject({ node: "svc/domain", declares: ["svc/domain"] });
  });

  it("reports what the policy would: the refused edges, the cycle, the missing sibling, the unresolved specifier", () => {
    expect(atlas.violations.map((one) => [one.kind, one.rule, one.file, one.subject])).toEqual([
      ["graph", "no-cycles", "svc/adapters/pg.go", "svc/adapters/pg.go ↔ svc/main.go"],
      ["import", "svc/adapters/imports", "svc/adapters/pg.go", "svc/main.go"],
      ["import", "svc/imports", "svc/main.go", "vendor.go"],
      ["structure", "svc/domain/*.go/requires", "svc/domain/model.go", "svc/domain/model_test.go"],
    ]);
    expect(atlas.violations.every((one) => !one.baselined)).toBe(true);
    expect(atlas.unresolved).toEqual([
      { file: "svc/main.go", specifier: "./missing", detail: "not staged in the fake" },
    ]);
    expect(atlas.cycles).toBe(1);
    expect(file("svc/adapters/pg.go").violations).toBe(2);
  });

  it("marks an allowance nothing imports through as unused", () => {
    const svc = node("svc");
    expect(svc.imports?.allowances.map((one) => [one.entry, one.kind, one.used])).toEqual([
      ["svc/**", "allow", true],
      ["os", "allow", true],
      ["pq", "external", true],
      ["unused-pkg", "external", false],
    ]);
    // `adapters/` resets, so its own `pq` is its own allowance, used by pg.go.
    expect(node("svc/adapters").imports).toMatchObject({
      reset: true,
      allowances: [
        { entry: "svc/domain/**", used: true },
        { entry: "svc/adapters/**", used: false },
        { entry: "pq", kind: "external", used: true },
      ],
    });
  });

  it("lists what a file owes and whether it is there", () => {
    expect(file("svc/domain/repo.go").requires).toEqual([
      { sibling: "svc/domain/repo_test.go", present: true, rule: "svc/domain/*.go/requires" },
    ]);
    expect(file("svc/domain/model.go").requires[0]?.present).toBe(false);
    expect(file("svc/domain/model.go").violations).toBe(1);
  });
});
