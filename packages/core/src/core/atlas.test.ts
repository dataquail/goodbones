import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { ImportRule, LoweredNode } from "../domain/architecture-config.js";
import type { SnapshotViolation } from "../domain/snapshot.js";
import { fingerprintOf, type Violation } from "../domain/violation.js";
import { type AtlasInput, atlasOf, targetKeyOf } from "./atlas.js";
import { EMPTY_GRAPH_RULES, type Graph } from "./graph.js";
import { compileImportRules, evaluateResolvedEdge, rulesSelecting } from "./imports.js";
import type { ObservedEdge } from "./slack.js";
import { EMPTY_STRUCTURE } from "./structure.js";

// A small repository stated as facts, the shape lowering produces written
// flat: `src/` with an allowlist, `src/domain/` tightening it, `scripts/`
// under no node. One violation, one ungoverned edge, one slack allowance.

const compile = (rules: ReadonlyArray<ImportRule>) => {
  const compiled = compileImportRules(rules);
  if (Result.isFailure(compiled)) throw compiled.failure;
  return compiled.success;
};

const probe = { from: "src/zz.ts", to: "src/nowhere.ts" };

const IMPORT_RULES = compile([
  {
    name: "src/imports",
    message: "src/ reaches itself, the runtime and effect.",
    probe,
    from: "^src/",
    fromNot: "^src/domain/",
    toNot: ["^src(/.*)?$", "^node:", "^vendor(/.*)?$"],
    externals: ["effect"],
    allowances: [
      { node: "src", kind: "allow", entry: "src/**", pattern: "^src(/.*)?$" },
      { node: "src", kind: "allow", entry: "node:**", pattern: "^node:" },
      { node: "src", kind: "allow", entry: "vendor/**", pattern: "^vendor(/.*)?$" },
      { node: "src", kind: "external", entry: "effect", fragment: "floor" },
    ],
  },
  {
    name: "src/domain/imports",
    message: "domain/ reaches only itself.",
    probe,
    from: "^src/domain/",
    toNot: ["^src/domain(/.*)?$"],
    allowances: [
      { node: "src/domain", kind: "allow", entry: "src/domain/**", pattern: "^src/domain(/.*)?$" },
    ],
  },
]);

const node = (
  path: string,
  name: string,
  parent: string | null,
  selector: string,
  message: string,
): LoweredNode => ({
  path,
  name,
  parent,
  kind: "folder",
  selector,
  message,
  layout: "open",
  unrestricted: false,
  partial: false,
  families: ["imports", "structure"],
});

const NODES = [
  node("src/", "src", null, "^src/", "src/ is the program."),
  node("src/domain/", "src/domain", "src", "^src/domain/", "domain/ is the model."),
];

const FILES = ["src/server.ts", "src/domain/user.ts", "src/domain/order.ts", "scripts/build.ts"];

const local = (path: string) => ({ path, kind: "local" as const });
const effect = {
  path: "node_modules/effect/index.js",
  kind: "external" as const,
  package: "effect",
};
const fs = { path: "node:fs", kind: "builtin" as const };

const EDGES: ReadonlyArray<ObservedEdge> = [
  { importer: "src/server.ts", target: local("src/domain/user.ts") },
  { importer: "src/server.ts", target: effect },
  { importer: "src/server.ts", target: fs },
  { importer: "src/domain/user.ts", target: local("src/domain/order.ts") },
  // Refused: domain/ may not reach effect.
  { importer: "src/domain/order.ts", target: effect },
  // From a file no allowlist selects.
  { importer: "scripts/build.ts", target: local("src/server.ts") },
];

// What `check` would have said about those edges, run through the evaluator
// rather than written by hand — the atlas lifts answers, never re-derives.
const reported = (violation: Violation): SnapshotViolation => ({
  ...violation,
  fingerprint: fingerprintOf(violation),
  baselined: false,
});
const VIOLATIONS = EDGES.flatMap((edge) =>
  evaluateResolvedEdge(rulesSelecting(IMPORT_RULES, edge.importer), edge.importer, edge.target),
).map(reported);

const GRAPH: Graph = {
  files: FILES,
  edges: new Map([
    ["src/server.ts", ["src/domain/user.ts"]],
    ["src/domain/user.ts", ["src/domain/order.ts"]],
    ["src/domain/order.ts", ["src/domain/user.ts"]],
    ["scripts/build.ts", ["src/server.ts"]],
  ]),
};

const INPUT: AtlasInput = {
  manifest: { path: "architecture.yaml", sha256: "abc" },
  roots: ["src", "scripts"],
  layers: [],
  nodes: NODES,
  policy: {
    importRules: IMPORT_RULES,
    structure: EMPTY_STRUCTURE,
    memberRules: [],
    surfaceRules: [],
    graph: EMPTY_GRAPH_RULES,
  },
  files: FILES,
  edges: EDGES,
  violations: VIOLATIONS,
  bindingViolations: [],
  unresolved: [],
  graph: GRAPH,
};

const atlas = atlasOf(INPUT);
const edge = (from: string, to: string) =>
  atlas.edges.find((one) => one.from === from && one.to === to);

describe("atlasOf", () => {
  it("names a target by its path, its package, or its runtime module", () => {
    expect(targetKeyOf(local("src/a.ts"))).toBe("src/a.ts");
    expect(targetKeyOf(effect)).toBe("pkg:effect");
    expect(targetKeyOf(fs)).toBe("builtin:node:fs");
  });

  it("lists every walked file with its governing node and reach, then the externals", () => {
    expect(atlas.files.map((one) => one.path)).toEqual([
      "scripts/build.ts",
      "src/domain/order.ts",
      "src/domain/user.ts",
      "src/server.ts",
      "builtin:node:fs",
      "pkg:effect",
    ]);
    expect(atlas.files.find((one) => one.path === "src/domain/user.ts")).toMatchObject({
      node: "src/domain",
      reach: { imports: true },
      layers: [],
      external: false,
    });
    expect(atlas.files.find((one) => one.path === "scripts/build.ts")).toMatchObject({
      node: null,
      reach: { imports: false, structure: null, members: false, surface: false, graph: false },
    });
    expect(atlas.files.find((one) => one.path === "pkg:effect")).toMatchObject({
      node: null,
      external: true,
    });
  });

  it("marks an edge admitted with the allowance that let it through", () => {
    expect(edge("src/server.ts", "src/domain/user.ts")).toEqual({
      from: "src/server.ts",
      to: "src/domain/user.ts",
      status: "admitted",
      admittedBy: { node: "src", kind: "allow", entry: "src/**" },
    });
    // An entry that came through `use` says so.
    expect(edge("src/server.ts", "pkg:effect")?.admittedBy).toEqual({
      node: "src",
      kind: "external",
      entry: "effect",
      fragment: "floor",
    });
    expect(edge("src/server.ts", "builtin:node:fs")?.admittedBy?.entry).toBe("node:**");
  });

  it("marks an edge a violation because the evaluator did, with the fingerprints", () => {
    expect(edge("src/domain/order.ts", "pkg:effect")).toEqual({
      from: "src/domain/order.ts",
      to: "pkg:effect",
      status: "violation",
      violations: ["import|src/domain/imports|src/domain/order.ts|node_modules/effect/index.js"],
    });
  });

  it("marks an edge from a file under no allowlist ungoverned", () => {
    expect(edge("scripts/build.ts", "src/server.ts")).toEqual({
      from: "scripts/build.ts",
      to: "src/server.ts",
      status: "ungoverned",
    });
  });

  it("attaches an exports violation to the edge it was found on", () => {
    const withBinding = atlasOf({
      ...INPUT,
      bindingViolations: [
        {
          importer: "src/server.ts",
          target: "src/domain/user.ts",
          fingerprint: "export|no-factories|src/server.ts|makeUser",
        },
      ],
    });
    expect(
      withBinding.edges.find(
        (one) => one.from === "src/server.ts" && one.to === "src/domain/user.ts",
      ),
    ).toEqual({
      from: "src/server.ts",
      to: "src/domain/user.ts",
      status: "violation",
      violations: ["export|no-factories|src/server.ts|makeUser"],
    });
  });

  it("carries every node with the allowances it wrote itself", () => {
    expect(atlas.nodes.map((one) => [one.name, one.allowances])).toEqual([
      [
        "src",
        [
          { kind: "allow", entry: "src/**" },
          { kind: "allow", entry: "node:**" },
          { kind: "allow", entry: "vendor/**" },
          { kind: "external", entry: "effect", fragment: "floor" },
        ],
      ],
      ["src/domain", [{ kind: "allow", entry: "src/domain/**" }]],
    ]);
  });

  it("resolves every allowance against the walk, and marks the unused ones", () => {
    const designed = (node: string, entry: string) =>
      atlas.designed.find((one) => one.node === node && one.allowance.entry === entry);
    expect(designed("src", "src/**")).toEqual({
      node: "src",
      allowance: { kind: "allow", entry: "src/**" },
      targets: ["src/domain/order.ts", "src/domain/user.ts", "src/server.ts"],
      used: true,
    });
    expect(designed("src", "effect")).toEqual({
      node: "src",
      allowance: { kind: "external", entry: "effect", fragment: "floor" },
      targets: ["pkg:effect"],
      used: true,
    });
    // Nothing on disk under vendor/, and nothing imports through it: slack.
    expect(designed("src", "vendor/**")).toEqual({
      node: "src",
      allowance: { kind: "allow", entry: "vendor/**" },
      targets: [],
      used: false,
    });
    // A builtin glob matches no walked file, but an edge uses it.
    expect(designed("src", "node:**")).toMatchObject({ targets: [], used: true });
    expect(designed("src/domain", "src/domain/**")).toMatchObject({
      targets: ["src/domain/order.ts", "src/domain/user.ts"],
      used: true,
    });
  });

  it("carries the cycles, the violations and the unresolved imports as given", () => {
    expect(atlas.cycles).toEqual([["src/domain/order.ts", "src/domain/user.ts"]]);
    expect(atlas.violations).toBe(VIOLATIONS);
    expect(atlas.version).toBe(1);
    expect(atlas.roots).toEqual(["src", "scripts"]);
  });

  it("keeps a local target outside the walk as a file, so its edge has somewhere to land", () => {
    const shared = { importer: "src/server.ts", target: local("vitest.shared.ts") };
    const outside = atlasOf({
      ...INPUT,
      edges: [...EDGES, shared],
      violations: [
        ...VIOLATIONS,
        ...evaluateResolvedEdge(
          rulesSelecting(IMPORT_RULES, shared.importer),
          shared.importer,
          shared.target,
        ).map(reported),
      ],
    });
    expect(outside.files.find((one) => one.path === "vitest.shared.ts")).toEqual({
      path: "vitest.shared.ts",
      node: null,
      reach: { imports: false, structure: null, members: false, surface: false, graph: false },
      layers: [],
      external: false,
    });
    expect(
      outside.edges.find((one) => one.from === "src/server.ts" && one.to === "vitest.shared.ts"),
    ).toMatchObject({ status: "violation" });
    // It is not a walked file, so no allowance's designed targets grow by it.
    expect(outside.designed.flatMap((one) => one.targets)).not.toContain("vitest.shared.ts");
  });

  it("gives each file its layer chain, outermost first, anchored where each was assigned", () => {
    const layered = atlasOf({
      ...INPUT,
      layers: [
        { id: "module", type: "enclosing" },
        { id: "domain", type: "tier" },
      ],
      nodes: [
        { ...node("src/", "src", null, "^src/", "src/ is the program."), layer: "module" },
        {
          ...node("src/domain/", "src/domain", "src", "^src/domain/", "domain/ is the model."),
          layer: "domain",
        },
        // A file key restating its folder's layer adds nothing: the outer
        // anchor stays the member.
        {
          ...node(
            "src/domain/user.ts",
            "src/domain/user.ts",
            "src/domain",
            "^src/domain/user\\.ts$",
            "the user",
          ),
          kind: "file",
          layer: "domain",
        },
      ],
    });
    const chain = (path: string) => layered.files.find((one) => one.path === path)?.layers;
    expect(chain("src/server.ts")).toEqual([{ id: "module", anchor: "src" }]);
    expect(chain("src/domain/order.ts")).toEqual([
      { id: "module", anchor: "src" },
      { id: "domain", anchor: "src/domain" },
    ]);
    expect(chain("src/domain/user.ts")).toEqual([
      { id: "module", anchor: "src" },
      { id: "domain", anchor: "src/domain" },
    ]);
    expect(chain("scripts/build.ts")).toEqual([]);
    expect(chain("pkg:effect")).toEqual([]);
    expect(layered.layers.map((one) => one.id)).toEqual(["module", "domain"]);
  });

  it("emits one edge per pair when several specifiers resolve into one target", () => {
    const doubled = atlasOf({
      ...INPUT,
      edges: [
        ...EDGES,
        { importer: "src/server.ts", target: { ...effect, path: "node_modules/effect/Result.js" } },
      ],
    });
    expect(doubled.edges.filter((one) => one.to === "pkg:effect")).toHaveLength(2);
  });
});
