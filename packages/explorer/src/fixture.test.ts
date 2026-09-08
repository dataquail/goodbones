import type { Atlas } from "@goodbones/core";
import { it } from "vitest";

// A small atlas the viewer's tests share: two tiers under `src/`, one
// package, one planted violation, one slack allowance. Exported from a test
// file so it is never a module the orphans rule has to know about.

export const FIXTURE: Atlas = {
  version: 1,
  manifest: { path: "architecture.yaml", sha256: "abc" },
  roots: ["src"],
  nodes: [
    {
      path: "src/",
      name: "src",
      parent: null,
      kind: "folder",
      selector: "^src/",
      message: "src/ is the program.",
      layout: "open",
      unrestricted: false,
      partial: false,
      families: ["imports", "structure"],
      allowances: [
        { kind: "allow", entry: "src/**" },
        { kind: "external", entry: "effect" },
        { kind: "allow", entry: "vendor/**" },
      ],
    },
    {
      path: "src/domain/",
      name: "src/domain",
      parent: "src",
      kind: "folder",
      selector: "^src/domain/",
      message: "domain/ is the model.",
      layout: "open",
      unrestricted: false,
      partial: false,
      families: ["imports", "structure"],
      allowances: [{ kind: "allow", entry: "src/domain/**" }],
    },
  ],
  files: [
    {
      path: "src/app/server.ts",
      node: "src",
      reach: { imports: true, structure: "open", members: false, surface: false, graph: false },
      external: false,
    },
    {
      path: "src/domain/order.ts",
      node: "src/domain",
      reach: { imports: true, structure: "open", members: false, surface: false, graph: false },
      external: false,
    },
    {
      path: "src/domain/user.ts",
      node: "src/domain",
      reach: { imports: true, structure: "open", members: false, surface: false, graph: false },
      external: false,
    },
    {
      path: "pkg:effect",
      node: null,
      reach: { imports: false, structure: null, members: false, surface: false, graph: false },
      external: true,
    },
  ],
  edges: [
    {
      from: "src/app/server.ts",
      to: "pkg:effect",
      status: "admitted",
      admittedBy: { node: "src", kind: "external", entry: "effect" },
    },
    {
      from: "src/app/server.ts",
      to: "src/domain/user.ts",
      status: "admitted",
      admittedBy: { node: "src", kind: "allow", entry: "src/**" },
    },
    {
      from: "src/domain/order.ts",
      to: "pkg:effect",
      status: "violation",
      violations: ["import|src/domain/imports|src/domain/order.ts|node_modules/effect/index.js"],
    },
    {
      from: "src/domain/user.ts",
      to: "src/domain/order.ts",
      status: "admitted",
      admittedBy: { node: "src/domain", kind: "allow", entry: "src/domain/**" },
    },
  ],
  designed: [
    {
      node: "src",
      allowance: { kind: "allow", entry: "src/**" },
      targets: ["src/app/server.ts", "src/domain/order.ts", "src/domain/user.ts"],
      used: true,
    },
    {
      node: "src",
      allowance: { kind: "external", entry: "effect" },
      targets: ["pkg:effect"],
      used: true,
    },
    { node: "src", allowance: { kind: "allow", entry: "vendor/**" }, targets: [], used: false },
  ],
  violations: [
    {
      fingerprint: "import|src/domain/imports|src/domain/order.ts|node_modules/effect/index.js",
      kind: "import",
      ruleName: "src/domain/imports",
      file: "src/domain/order.ts",
      subject: "node_modules/effect/index.js",
      message: "domain/ reaches only itself.",
      baselined: false,
    },
  ],
  cycles: [],
  unresolved: [],
};

it("is a fixture", () => {});
