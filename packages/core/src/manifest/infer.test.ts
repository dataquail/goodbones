import { describe, expect, it } from "vitest";

import { lowerManifest } from "./compile.js";
import {
  type Candidate,
  candidatesOf,
  type InferInput,
  inferManifest,
  type InferOptions,
  type InferredTarget,
  singularOf,
} from "./infer.js";
import { decodeManifest, type ManifestNode } from "./manifest.js";

// A module-shaped application, stated as facts: which files exist, and what
// each one resolves to. Two modules share a shape; a third sibling does not.
// `commands/` and `domain/` sit one level beyond the depth, so they are
// governed by their module rather than nodes of their own.
const local = (path: string): InferredTarget => ({ kind: "local", path });
const external = (name: string): InferredTarget => ({ kind: "external", package: name });
const builtin = (path: string): InferredTarget => ({ kind: "builtin", path });

const EDGES: Readonly<Record<string, ReadonlyArray<InferredTarget>>> = {
  "src/server.ts": [
    local("src/modules/auth/index.ts"),
    local("src/modules/billing/index.ts"),
    external("effect"),
    builtin("node:fs"),
  ],
  "src/modules/auth/index.ts": [local("src/modules/auth/commands/login.handler.ts")],
  "src/modules/auth/commands/login.handler.ts": [
    local("src/modules/auth/domain/user.ts"),
    local("src/platform/db.ts"),
  ],
  "src/modules/auth/domain/user.ts": [],
  "src/modules/billing/index.ts": [local("src/modules/billing/commands/charge.handler.ts")],
  "src/modules/billing/commands/charge.handler.ts": [
    local("src/modules/billing/domain/invoice.ts"),
    local("src/modules/auth/index.ts"),
    local("src/platform/db.ts"),
  ],
  "src/modules/billing/domain/invoice.ts": [external("effect")],
  "src/modules/billing/domain/deep/nested.ts": [local("src/modules/billing/domain/invoice.ts")],
  "src/modules/shared-kernel/util.ts": [],
  "src/platform/db.ts": [local("vitest.shared.ts")],
};

const APP: InferInput = {
  files: Object.keys(EDGES).sort(),
  targetsOf: (file) => EDGES[file] ?? [],
  roots: ["src"],
  packages: [{ root: "", source: "src" }],
  depth: 2,
};

const OPTIONS: InferOptions = {
  generalize: [],
  collapse: false,
  date: "2026-09-07",
  resolve: { scopes: [{ files: "", language: "typescript" }] },
  baseline: ".architecture-baseline.json",
  hasCycles: false,
};

const nodeAt = (tree: Readonly<Record<string, ManifestNode>>, ...keys: ReadonlyArray<string>) => {
  let at: ManifestNode | undefined;
  let children: Readonly<Record<string, ManifestNode>> | undefined = tree;
  for (const key of keys) {
    at = children?.[key];
    children = at?.children;
  }
  if (at === undefined) throw new Error(`no node at ${keys.join(" ")}`);
  return at;
};

describe("inferManifest", () => {
  const { manifest } = inferManifest(APP, OPTIONS);

  it("writes one open node per folder to the depth, and a catch-all beneath a leaf with more", () => {
    const modules = nodeAt(manifest.tree, "src/", "modules/");
    expect(Object.keys(modules.children ?? {})).toEqual(["auth/", "billing/", "shared-kernel/"]);
    expect(nodeAt(manifest.tree, "src/", "modules/", "auth/").children).toEqual({
      "**/": { layout: "open", children: {} },
    });
    expect(nodeAt(manifest.tree, "src/", "platform/").children).toEqual({});
    expect(nodeAt(manifest.tree, "src/").layout).toBe("open");
  });

  it("fills each node's allowlist from the edges of the files it governs, at node granularity", () => {
    // `commands/` and `domain/` are beyond the depth, so an edge into either is
    // the module's own `**`; the file it lands on is not named.
    const billing = nodeAt(manifest.tree, "src/", "modules/", "billing/").imports;
    expect(billing?.message).toContain("src/modules/billing/");
    expect(billing?.unrestricted).toBe(true);
    expect(billing?.allow).toEqual([
      "src/modules/auth/**",
      "src/modules/billing/**",
      "src/platform/**",
    ]);
    expect(billing?.external).toEqual(["effect"]);
    expect(nodeAt(manifest.tree, "src/", "modules/", "auth/").imports?.allow).toEqual([
      "src/modules/auth/**",
      "src/platform/**",
    ]);
  });

  it("admits a builtin by its own name, and a target outside every root by its path", () => {
    expect(nodeAt(manifest.tree, "src/").imports?.allow).toEqual([
      "node:fs",
      "src/modules/auth/**",
      "src/modules/billing/**",
    ]);
    expect(nodeAt(manifest.tree, "src/", "platform/").imports?.allow).toEqual(["vitest.shared.ts"]);
  });

  it("gives a folder with no files of its own no import policy", () => {
    expect(nodeAt(manifest.tree, "src/", "modules/").imports).toBeUndefined();
  });

  it("marks every node unrestricted and counts them in the ceiling", () => {
    const nodes: Array<ManifestNode> = [];
    const walk = (node: ManifestNode) => {
      nodes.push(node);
      for (const child of Object.values(node.children ?? {})) walk(child);
    };
    for (const root of Object.values(manifest.tree)) walk(root);
    const withImports = nodes.filter((node) => node.imports !== undefined);
    expect(withImports.every((node) => node.imports?.unrestricted === true)).toBe(true);
    expect(manifest.limits?.unrestricted).toBe(withImports.length);
    expect(manifest.limits?.partial).toBe(0);
  });

  it("dates every node and counts what it governs", () => {
    expect(nodeAt(manifest.tree, "src/", "modules/", "billing/").message).toBe(
      "As built on 2026-09-07: 4 files, 6 edges.",
    );
    expect(nodeAt(manifest.tree, "src/").message).toBe("As built on 2026-09-07: 1 file, 4 edges.");
  });

  it("writes a no-cycles rule only when the tree has no cycle today", () => {
    expect(manifest.graph?.cycles?.[0]?.within).toBe("src/**");
    expect(inferManifest(APP, { ...OPTIONS, hasCycles: true }).manifest.graph).toBeUndefined();
    const two = inferManifest(
      { ...APP, roots: ["src", "lib"] },
      { ...OPTIONS, resolve: OPTIONS.resolve },
    ).manifest;
    expect(two.graph?.cycles?.[0]?.within).toEqual(["src/**", "lib/**"]);
  });

  it("carries the resolve block and the baseline through", () => {
    expect(manifest.resolve).toEqual(OPTIONS.resolve);
    expect(manifest.baseline).toBe(".architecture-baseline.json");
    expect(manifest.aliases).toBeUndefined();
  });

  it("shortens what it writes with the aliases it is given, keys included", () => {
    const aliased = inferManifest(APP, { ...OPTIONS, aliases: { "@": "src" } }).manifest;
    expect(aliased.aliases).toEqual({ "@": "src" });
    expect(Object.keys(aliased.tree)).toEqual(["@/"]);
    expect(nodeAt(aliased.tree, "@/", "modules/", "billing/").imports?.allow).toEqual([
      "@/modules/auth/**",
      "@/modules/billing/**",
      "@/platform/**",
    ]);
    expect(aliased.graph?.cycles?.[0]?.within).toBe("@/**");
  });

  it("is deterministic whatever order the files arrive in", () => {
    const reversed = inferManifest({ ...APP, files: [...APP.files].reverse() }, OPTIONS);
    expect(reversed.manifest).toEqual(manifest);
  });
});

describe("inferManifest: depth and packages", () => {
  const MONOREPO: InferInput = {
    files: [
      "packages/core/vitest.config.ts",
      "packages/core/src/index.ts",
      "packages/core/src/domain/x.ts",
      "packages/core/src/domain/deep/y.ts",
      "packages/cli/src/main.ts",
    ],
    targetsOf: (file) =>
      file === "packages/cli/src/main.ts"
        ? [local("packages/core/src/index.ts"), local("packages/core/src/domain/x.ts")]
        : file === "packages/core/src/domain/deep/y.ts"
          ? [local("packages/core/src/domain/x.ts")]
          : [],
    roots: ["packages"],
    packages: [
      { root: "packages/core", source: "packages/core/src" },
      { root: "packages/cli", source: "packages/cli/src" },
    ],
    depth: 1,
  };

  it("counts the depth from a package's source root, and keeps the folders on the way as nodes", () => {
    const { manifest } = inferManifest(MONOREPO, OPTIONS);
    expect(Object.keys(nodeAt(manifest.tree, "packages/").children ?? {})).toEqual([
      "cli/",
      "core/",
    ]);
    const core = nodeAt(manifest.tree, "packages/", "core/");
    // The package node governs the config beside `src/`, which imports
    // nothing: a policy with nothing to allow, and nothing to forbid yet.
    expect(core.imports?.unrestricted).toBe(true);
    expect(core.imports?.allow).toBeUndefined();
    expect(core.imports?.external).toBeUndefined();
    expect(Object.keys(core.children ?? {})).toEqual(["src/"]);
    const src = nodeAt(manifest.tree, "packages/", "core/", "src/");
    expect(Object.keys(src.children ?? {})).toEqual(["domain/"]);
    // `deep/` is two below `src`, one past the depth: the domain node's.
    expect(nodeAt(manifest.tree, "packages/", "core/", "src/", "domain/").children).toEqual({
      "**/": { layout: "open", children: {} },
    });
    expect(nodeAt(manifest.tree, "packages/", "core/", "src/", "domain/").message).toContain(
      "2 files",
    );
  });

  it("names a file directly in a node that has children as that node's `*`", () => {
    const { manifest } = inferManifest(MONOREPO, OPTIONS);
    expect(nodeAt(manifest.tree, "packages/", "cli/", "src/").imports?.allow).toEqual([
      "packages/core/src/*",
      "packages/core/src/domain/**",
    ]);
  });

  it("governs a package's own files by the package node, whatever the depth", () => {
    const { manifest } = inferManifest({ ...MONOREPO, depth: 0 }, OPTIONS);
    const core = nodeAt(manifest.tree, "packages/", "core/");
    expect(core.message).toContain("1 file");
    expect(Object.keys(core.children ?? {})).toEqual(["src/"]);
    // At depth 0 the source root is the leaf; everything beneath is its own.
    expect(nodeAt(manifest.tree, "packages/", "core/", "src/").children).toEqual({
      "**/": { layout: "open", children: {} },
    });
  });

  it("counts from the walk root when nothing marks a package", () => {
    const { manifest } = inferManifest({ ...MONOREPO, packages: [] }, OPTIONS);
    // Depth 1 below `packages`: `core/` and `cli/` are leaves.
    expect(nodeAt(manifest.tree, "packages/", "core/").children).toEqual({
      "**/": { layout: "open", children: {} },
    });
    expect(nodeAt(manifest.tree, "packages/", "cli/").imports?.allow).toEqual(["packages/core/**"]);
  });
});

describe("candidatesOf", () => {
  const candidates = candidatesOf(APP);

  it("groups siblings that share two subfolders, and leaves the odd one out", () => {
    expect(candidates).toHaveLength(1);
    const [group] = candidates;
    expect(group).toMatchObject({
      parent: "src/modules",
      members: ["auth", "billing"],
      sharedFolders: ["commands", "domain"],
      sharedStereotypes: ["index.ts"],
      capture: "module",
    } satisfies Partial<Candidate>);
  });

  it("notices when every edge between members lands on one place", () => {
    expect(candidates[0]).toMatchObject({ crossEdges: 1, crossReach: "index.ts" });
  });

  it("groups siblings by the kinds of file they hold when they have no subfolders", () => {
    const flat: InferInput = {
      files: [
        "src/handlers/a.handler.ts",
        "src/handlers/a.test.ts",
        "src/handlers/b.handler.ts",
        "src/handlers/b.test.ts",
        "src/handlers/readme.ts",
      ],
      targetsOf: () => [],
      roots: ["src"],
      packages: [],
      depth: 3,
    };
    // Files, not folders: nothing to group.
    expect(candidatesOf(flat)).toEqual([]);

    const folders: InferInput = {
      ...flat,
      files: [
        "src/features/a/a.handler.ts",
        "src/features/a/a.test.ts",
        "src/features/b/b.handler.ts",
        "src/features/b/b.test.ts",
        "src/features/c/readme.ts",
      ],
    };
    expect(candidatesOf(folders)).toMatchObject([
      { parent: "src/features", members: ["a", "b"], capture: "feature", crossReach: null },
    ]);
  });

  it("offers nothing inside a node already generalized", () => {
    const [group] = candidates;
    if (group === undefined) throw new Error("expected a candidate");
    expect(candidatesOf(APP, [{ ...group, crossReach: null }])).toEqual([]);
  });
});

describe("inferManifest: generalization", () => {
  const [group] = candidatesOf(APP);
  if (group === undefined) throw new Error("expected a candidate");
  const tightened = inferManifest(APP, {
    ...OPTIONS,
    generalize: [{ ...group, crossReach: "index.ts" }],
  }).manifest;
  const loose = inferManifest(APP, {
    ...OPTIONS,
    generalize: [{ ...group, crossReach: null }],
  }).manifest;

  it("replaces the members with one captured node and merges what they govern", () => {
    const modules = nodeAt(tightened.tree, "src/", "modules/");
    expect(Object.keys(modules.children ?? {})).toEqual(["shared-kernel/", "{module}/"]);
    const module = nodeAt(tightened.tree, "src/", "modules/", "{module}/");
    expect(module.message).toBe(
      "As built on 2026-09-07 across 2 modules (auth, billing): 7 files, 9 edges.",
    );
    expect(module.children).toEqual({ "**/": { layout: "open", children: {} } });
  });

  it("keeps the capture for a member's own edges and stars it for a sibling's", () => {
    expect(nodeAt(loose.tree, "src/", "modules/", "{module}/").imports?.allow).toEqual([
      "src/modules/*/**",
      "src/modules/{module}/**",
      "src/platform/**",
    ]);
    // An outsider reaching in sees every member alike.
    expect(nodeAt(loose.tree, "src/").imports?.allow).toEqual(["node:fs", "src/modules/*/**"]);
  });

  it("writes the tightening as the one path every cross-member edge lands on", () => {
    expect(nodeAt(tightened.tree, "src/", "modules/", "{module}/").imports?.allow).toEqual([
      "src/modules/*/index.ts",
      "src/modules/{module}/**",
      "src/platform/**",
    ]);
  });

  it("loads: the captured key and the entries that use it decode as a manifest", () => {
    const decoded = decodeManifest("architecture.yaml", tightened);
    if (decoded._tag !== "Success") throw new Error(decoded.failure.message);
    const lowered = lowerManifest(decoded.success.manifest);
    expect(lowered.adoption.unrestricted).toContain("src/modules/{module}");
  });
});

describe("inferManifest: collapse", () => {
  const RING: InferInput = {
    files: ["lib/a/x.ts", "lib/b/y.ts", "lib/c/z.ts", "lib/index.ts"],
    targetsOf: (file) =>
      ({
        "lib/a/x.ts": [local("lib/b/y.ts"), external("effect")],
        "lib/b/y.ts": [local("lib/a/x.ts"), external("effect")],
        "lib/c/z.ts": [local("lib/a/x.ts"), external("effect")],
        "lib/index.ts": [local("lib/c/z.ts")],
      })[file] ?? [],
    roots: ["lib"],
    packages: [],
    depth: 1,
  };

  it("folds children that all reach the same things into their parent", () => {
    const { manifest } = inferManifest(RING, { ...OPTIONS, collapse: true });
    const lib = nodeAt(manifest.tree, "lib/");
    expect(lib.children).toEqual({ "**/": { layout: "open", children: {} } });
    expect(lib.imports?.unrestricted).toBe(true);
    expect(lib.imports?.allow).toEqual(["lib/**"]);
    expect(lib.imports?.external).toEqual(["effect"]);
    expect(lib.message).toContain("4 files");
    expect(manifest.limits?.unrestricted).toBe(1);
  });

  it("leaves them alone otherwise", () => {
    const { manifest } = inferManifest(RING, OPTIONS);
    expect(Object.keys(nodeAt(manifest.tree, "lib/").children ?? {})).toEqual(["a/", "b/", "c/"]);
    const differing = inferManifest(
      {
        ...RING,
        targetsOf: (file) => (file === "lib/c/z.ts" ? [builtin("node:fs")] : RING.targetsOf(file)),
      },
      { ...OPTIONS, collapse: true },
    ).manifest;
    expect(Object.keys(nodeAt(differing.tree, "lib/").children ?? {})).toEqual(["a/", "b/", "c/"]);
  });
});

describe("singularOf", () => {
  it("names the capture the way a human would", () => {
    expect(singularOf("modules")).toBe("module");
    expect(singularOf("packages")).toBe("package");
    expect(singularOf("entities")).toBe("entity");
    expect(singularOf("boxes")).toBe("box");
    expect(singularOf("classes")).toBe("class");
    expect(singularOf("process")).toBe("process");
    expect(singularOf("src")).toBe("src");
    expect(singularOf("shared-kernel")).toBe("sharedkernel");
    expect(singularOf("")).toBe("name");
    expect(singularOf("3rd")).toBe("name");
  });
});
