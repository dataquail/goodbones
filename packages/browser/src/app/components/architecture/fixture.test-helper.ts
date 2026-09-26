import type { Atlas, AtlasEdge, AtlasFile, AtlasFolder, AtlasNode } from "../../../model/atlas.js";

// A small atlas by hand: two folders, four files, three edges (one refused),
// two nodes with positions in a six-line manifest.

export const file = (path: string, overrides: Partial<AtlasFile> = {}): AtlasFile => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  folder: path.slice(0, Math.max(0, path.lastIndexOf("/"))),
  walked: true,
  node: null,
  chain: [],
  importRules: [],
  requires: [],
  externals: [],
  builtins: [],
  violations: 0,
  ...overrides,
});

export const folder = (path: string, overrides: Partial<AtlasFolder> = {}): AtlasFolder => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  parent: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null,
  depth: path.split("/").length - 1,
  node: null,
  declares: [],
  ...overrides,
});

export const edge = (from: string, to: string, overrides: Partial<AtlasEdge> = {}): AtlasEdge => ({
  from,
  to,
  specifiers: [`./${to.slice(to.lastIndexOf("/") + 1)}`],
  status: "allowed",
  admittedBy: { node: "svc", entry: "svc/**", fragment: null },
  refusedBy: [],
  ...overrides,
});

export const node = (id: string, overrides: Partial<AtlasNode> = {}): AtlasNode => ({
  id,
  key: `${id.slice(id.lastIndexOf("/") + 1)}/`,
  path: `${id}/`,
  parent: id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : null,
  depth: id.split("/").length - 1,
  folder: true,
  message: null,
  layout: "open",
  partial: false,
  position: null,
  imports: null,
  importedBy: null,
  members: [],
  surface: [],
  requires: [],
  children: [],
  rules: [],
  files: 0,
  ...overrides,
});

export const MANIFEST = [
  "tree:",
  '  "svc/":',
  "    children:",
  '      "domain/":',
  "        imports: {}",
  "",
].join("\n");

export const atlas = (): Atlas => ({
  version: 1,
  name: "repo",
  generatedAt: "2026-09-26T12:00:00.000Z",
  roots: ["svc"],
  manifest: {
    path: "architecture.yaml",
    files: [{ path: "architecture.yaml", text: MANIFEST }],
    aliases: {},
    nodes: [
      node("svc", {
        children: ["svc/domain"],
        position: { file: "architecture.yaml", line: 2, column: 3 },
        files: 1,
      }),
      node("svc/domain", {
        position: { file: "architecture.yaml", line: 4, column: 7 },
        files: 2,
        imports: {
          message: null,
          reset: false,
          unrestricted: false,
          allowances: [
            {
              kind: "allow",
              entry: "svc/domain/**",
              expanded: "svc/domain/**",
              fragment: null,
              used: true,
            },
            { kind: "external", entry: "unused", expanded: "unused", fragment: null, used: false },
          ],
          deny: [],
        },
      }),
    ],
    rules: [],
  },
  files: [
    file("svc/main.go", { node: "svc", chain: ["svc"], violations: 1 }),
    file("svc/domain/repo.go", { node: "svc/domain", chain: ["svc", "svc/domain"] }),
    file("svc/domain/model.go", { node: "svc/domain", chain: ["svc", "svc/domain"] }),
    file("svc/adapters/pg.go", { node: "svc", chain: ["svc"] }),
  ],
  folders: [
    folder("svc", { node: "svc", declares: ["svc"] }),
    folder("svc/adapters", { node: "svc" }),
    folder("svc/domain", { node: "svc/domain", declares: ["svc/domain"] }),
  ],
  edges: [
    edge("svc/main.go", "svc/domain/repo.go"),
    edge("svc/domain/repo.go", "svc/domain/model.go"),
    edge("svc/adapters/pg.go", "svc/main.go", {
      status: "refused",
      admittedBy: null,
      refusedBy: [{ rule: "svc/adapters/imports", message: "[svc/adapters/imports] no" }],
    }),
  ],
  violations: [
    {
      fingerprint: "import|svc/adapters/imports|svc/adapters/pg.go|svc/main.go",
      kind: "import",
      rule: "svc/adapters/imports",
      file: "svc/adapters/pg.go",
      subject: "svc/main.go",
      message: "[svc/adapters/imports] no",
      baselined: false,
    },
  ],
  unresolved: [],
  cycles: 0,
});
