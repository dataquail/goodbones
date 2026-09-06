import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ConfigInvalid } from "../domain/architecture-error.js";
import { readManifestFile } from "./manifest-file.js";

// Inside the package rather than the OS temp dir, as the reader's own tests
// are: a module manifest's dynamic import goes through Vitest's module graph.
const scratch = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.tmp-manifest-include",
);
mkdirSync(scratch, { recursive: true });

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

let counter = 0;
// Writes each file at its path under a fresh repository, directories included.
const repo = (files: Readonly<Record<string, string>>): string => {
  counter += 1;
  const root = path.join(scratch, `repo-${String(counter)}`);
  for (const [name, text] of Object.entries(files)) {
    const at = path.join(root, name);
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, text);
  }
  return root;
};

const read = (root: string, name = "architecture.yaml") => readManifestFile(path.join(root, name));

const refused = async (root: string, name?: string): Promise<string> => {
  try {
    await read(root, name);
  } catch (error) {
    if (error instanceof ConfigInvalid) return error.detail;
    throw error;
  }
  throw new Error("expected the manifest to be refused");
};

const NODE = `message: "the server"
layout: open
children: {}
members:
  - subject: calls
    message: "no fs"
    match: ["*Sync"]
`;

describe("include", () => {
  it("replaces the reference with the file's value, and lists every file read", async () => {
    const root = repo({
      "architecture.yaml": `tree:\n  "packages/server/": { include: packages/server/architecture.yaml }\n`,
      "packages/server/architecture.yaml": NODE,
    });
    const manifest = await read(root);
    expect(manifest.manifest).toEqual({
      tree: {
        "packages/server/": {
          message: "the server",
          layout: "open",
          children: {},
          members: [{ subject: "calls", message: "no fs", match: ["*Sync"] }],
        },
      },
    });
    expect(manifest.files).toEqual([
      path.join(root, "architecture.yaml"),
      path.join(root, "packages/server/architecture.yaml"),
    ]);
  });

  it("locates a path inside an included file, naming the file relative to the manifest", async () => {
    const root = repo({
      "architecture.yaml": `tree:\n  "packages/server/": { include: packages/server/architecture.yaml }\n`,
      "packages/server/architecture.yaml": NODE,
    });
    const { locate } = await read(root);
    expect(locate?.(["tree", "packages/server/", "members", 0, "subject"])).toEqual({
      line: 5,
      column: 5,
      file: "packages/server/architecture.yaml",
    });
    // A path in the manifest file itself names no file.
    expect(locate?.(["tree"])).toEqual({ line: 1, column: 1 });
    // The include site itself answers with the top of the included file.
    expect(locate?.(["tree", "packages/server/"])).toEqual({
      line: 1,
      column: 1,
      file: "packages/server/architecture.yaml",
    });
  });

  it("resolves a path relative to the file that wrote it, at any depth", async () => {
    const root = repo({
      "architecture.yaml": `tree:\n  "packages/": { include: packages/architecture.yaml }\n`,
      "packages/architecture.yaml": `children:\n  "server/": { include: ./server/node.yaml }\n`,
      "packages/server/node.yaml": NODE,
    });
    const { locate, manifest } = await read(root);
    expect(
      (manifest as { tree: { "packages/": { children: object } } }).tree["packages/"].children,
    ).toEqual({
      "server/": {
        message: "the server",
        layout: "open",
        children: {},
        members: [{ subject: "calls", message: "no fs", match: ["*Sync"] }],
      },
    });
    expect(locate?.(["tree", "packages/", "children", "server/", "message"])).toEqual({
      line: 1,
      column: 1,
      file: "packages/server/node.yaml",
    });
    expect(locate?.(["tree", "packages/", "children", "server/"])).toEqual({
      line: 1,
      column: 1,
      file: "packages/server/node.yaml",
    });
    expect(locate?.(["tree", "packages/", "children"])).toEqual({
      line: 1,
      column: 1,
      file: "packages/architecture.yaml",
    });
  });

  it("works the same in JSON, and drops the included file's $schema", async () => {
    const root = repo({
      "architecture.json": '{ "tree": { "src/": { "include": "src.json" } } }',
      "src.json": '{\n  "$schema": "https://…",\n  "layout": "open",\n  "children": {}\n}\n',
    });
    const manifest = await read(root, "architecture.json");
    expect(manifest.manifest).toEqual({ tree: { "src/": { layout: "open", children: {} } } });
    expect(manifest.locate?.(["tree", "src/", "layout"])).toEqual({
      line: 3,
      column: 3,
      file: "src.json",
    });
  });

  it("gives a module manifest positions for what it includes", async () => {
    const root = repo({
      "architecture.config.mjs": 'export default { tree: { "src/": { include: "src.yaml" } } };',
      "src.yaml": "layout: open\nchildren: {}\n",
    });
    const manifest = await read(root, "architecture.config.mjs");
    expect(manifest.manifest).toEqual({ tree: { "src/": { layout: "open", children: {} } } });
    expect(manifest.locate?.(["tree", "src/", "children"])).toEqual({
      line: 2,
      column: 1,
      file: "src.yaml",
    });
    expect(manifest.locate?.(["tree"])).toBeNull();
  });

  it("hands back the reader's own locator when nothing is included", async () => {
    const root = repo({ "architecture.yaml": "tree: {}\n" });
    const manifest = await read(root);
    expect(manifest.files).toEqual([path.join(root, "architecture.yaml")]);
    expect(manifest.locate?.(["tree"])).toEqual({ line: 1, column: 1 });
  });

  it("can stand in for a whole section, or the tree", async () => {
    const root = repo({
      "architecture.yaml": "graph: { include: graph.yaml }\ntree: { include: tree.yaml }\n",
      "graph.yaml": 'cycles:\n  - name: no-cycles\n    message: m\n    within: "**"\n',
      "tree.yaml": '"src/": { layout: open, children: {} }\n',
    });
    const manifest = await read(root);
    expect(manifest.manifest).toEqual({
      graph: { cycles: [{ name: "no-cycles", message: "m", within: "**" }] },
      tree: { "src/": { layout: "open", children: {} } },
    });
    expect(manifest.locate?.(["graph", "cycles", 0, "within"])).toEqual({
      line: 4,
      column: 5,
      file: "graph.yaml",
    });
  });
});

describe("include, as a list item", () => {
  it("splices a file that holds a list, and locates every item where it now stands", async () => {
    const root = repo({
      "architecture.yaml":
        "exports:\n  - name: first\n  - include: rules/shared.yaml\n  - name: last\n",
      "rules/shared.yaml": "- name: shared-a\n- name: shared-b\n",
    });
    const { locate, manifest } = await read(root);
    expect(manifest).toEqual({
      exports: [{ name: "first" }, { name: "shared-a" }, { name: "shared-b" }, { name: "last" }],
    });
    expect(locate?.(["exports", 0, "name"])).toEqual({ line: 2, column: 5 });
    expect(locate?.(["exports", 1, "name"])).toEqual({
      line: 1,
      column: 3,
      file: "rules/shared.yaml",
    });
    expect(locate?.(["exports", 2, "name"])).toEqual({
      line: 2,
      column: 3,
      file: "rules/shared.yaml",
    });
    // Shifted by the splice before it, and still found at its own line.
    expect(locate?.(["exports", 3, "name"])).toEqual({ line: 4, column: 5 });
  });

  it("splices a spliced file's own list includes, in order", async () => {
    const root = repo({
      "architecture.yaml": "exports:\n  - include: a.yaml\n  - name: last\n",
      "a.yaml": "- name: a-1\n- include: b.yaml\n- name: a-3\n",
      "b.yaml": "- name: b\n",
    });
    const { locate, manifest } = await read(root);
    expect(manifest).toEqual({
      exports: [{ name: "a-1" }, { name: "b" }, { name: "a-3" }, { name: "last" }],
    });
    expect(locate?.(["exports", 1, "name"])).toEqual({ line: 1, column: 3, file: "b.yaml" });
    expect(locate?.(["exports", 2, "name"])).toEqual({ line: 3, column: 3, file: "a.yaml" });
    expect(locate?.(["exports", 3, "name"])).toEqual({ line: 3, column: 5 });
  });

  it("places a file that holds an object as one item", async () => {
    const root = repo({
      "architecture.yaml": "exports:\n  - include: rule.yaml\n",
      "rule.yaml": "name: one\n",
    });
    const { manifest } = await read(root);
    expect(manifest).toEqual({ exports: [{ name: "one" }] });
  });
});

describe("include and defs", () => {
  it("hoists an included file's defs into the manifest's, and locates them there", async () => {
    const root = repo({
      "architecture.yaml":
        'defs:\n  floor: { allow: [] }\ntree:\n  "src/": { include: src.yaml }\n',
      "src.yaml":
        "defs:\n  local-rule: { subject: calls, message: m }\nmembers: [{ use: local-rule }]\n",
    });
    const { locate, manifest } = await read(root);
    expect(manifest).toEqual({
      defs: { floor: { allow: [] }, "local-rule": { subject: "calls", message: "m" } },
      tree: { "src/": { members: [{ use: "local-rule" }] } },
    });
    expect(locate?.(["defs", "local-rule", "subject"])).toEqual({
      line: 2,
      column: 17,
      file: "src.yaml",
    });
    expect(locate?.(["defs", "floor"])).toEqual({ line: 2, column: 3 });
  });

  it("does not hoist out of a file included under defs, where the keys are the author's", async () => {
    const root = repo({
      "architecture.yaml": "defs: { include: defs.yaml }\ntree: {}\n",
      "defs.yaml": "defs: { subject: calls }\n$schema: { subject: members }\n",
    });
    const { manifest } = await read(root);
    expect(manifest).toEqual({
      defs: { defs: { subject: "calls" }, $schema: { subject: "members" } },
      tree: {},
    });
  });

  it("refuses a name two included files both define", async () => {
    const root = repo({
      "architecture.yaml": 'tree:\n  "a/": { include: a.yaml }\n  "b/": { include: b.yaml }\n',
      "a.yaml": "defs:\n  rule: { subject: calls }\n",
      "b.yaml": "defs:\n  rule: { subject: calls }\n",
    });
    await expect(refused(root)).resolves.toMatch(
      /b\.yaml:2:3 {2}defs\.rule: `defs\.rule` is already defined in a\.yaml/,
    );
  });

  it("refuses a name the manifest and an included file both define", async () => {
    const root = repo({
      "architecture.yaml": 'defs:\n  rule: {}\ntree:\n  "a/": { include: a.yaml }\n',
      "a.yaml": "defs:\n  rule: { subject: calls }\n",
    });
    await expect(refused(root)).resolves.toMatch(
      /architecture\.yaml:2:3 {2}defs\.rule: `defs\.rule` is also defined in a\.yaml/,
    );
  });
});

describe("include, refused", () => {
  it("names the site of a file that does not exist", async () => {
    const root = repo({
      "architecture.yaml": 'tree:\n  "src/":\n    include: nope/src.yaml\n',
    });
    // At the key that holds the reference, where the reader's eye lands.
    await expect(refused(root)).resolves.toBe(
      "the manifest does not include:\n" +
        '  architecture.yaml:2:3  tree["src/"]: `include: "nope/src.yaml"` names a file that ' +
        "does not exist (looked for nope/src.yaml, relative to architecture.yaml).",
    );
  });

  it("names the including file when it is not the manifest", async () => {
    const root = repo({
      "architecture.yaml": 'tree:\n  "src/": { include: src/node.yaml }\n',
      "src/node.yaml": "children:\n  x/: { include: missing.yaml }\n",
    });
    await expect(refused(root)).resolves.toMatch(
      /src\/node\.yaml:2:3 {2}children\["x\/"\]: `include: "missing\.yaml"` names a file that does not exist \(looked for src\/missing\.yaml, relative to src\/node\.yaml\)/,
    );
  });

  it("refuses a cycle, naming the chain", async () => {
    const root = repo({
      "architecture.yaml": "tree: { include: a.yaml }\n",
      "a.yaml": "x: { include: b.yaml }\n",
      "b.yaml": "y: { include: a.yaml }\n",
    });
    await expect(refused(root)).resolves.toMatch(
      /b\.yaml:1:1 {2}y: `include: "a\.yaml"` includes a file that is already being included: architecture\.yaml → a\.yaml → b\.yaml → a\.yaml\./,
    );
  });

  it("refuses a file that includes itself", async () => {
    const root = repo({ "architecture.yaml": "tree: { include: architecture.yaml }\n" });
    await expect(refused(root)).resolves.toMatch(/already being included/);
  });

  it("refuses a module", async () => {
    const root = repo({ "architecture.yaml": "tree: { include: tree.mjs }\n" });
    await expect(refused(root)).resolves.toMatch(
      /tree: `include: "tree\.mjs"` names a file that is not YAML or JSON/,
    );
  });

  it("refuses a key written beside include", async () => {
    const root = repo({
      "architecture.yaml": 'tree:\n  "src/": { include: src.yaml, layout: open }\n',
      "src.yaml": "children: {}\n",
    });
    await expect(refused(root)).resolves.toMatch(
      /tree\["src\/"\]: `include: "src\.yaml"` stands alone: .* nothing for `layout` to override/,
    );
  });

  it("refuses an include that is not a string", async () => {
    const root = repo({ "architecture.yaml": "tree: { include: [a.yaml] }\n" });
    await expect(refused(root)).resolves.toMatch(/tree: `include` names a file, as a string\./);
  });

  it("reports a syntax error in an included file against that file", async () => {
    const root = repo({
      "architecture.yaml": "tree: { include: tree.yaml }\n",
      "tree.yaml": "src/: {\n",
    });
    await expect(read(root)).rejects.toMatchObject({
      configPath: path.join(root, "tree.yaml"),
      detail: expect.stringMatching(/does not parse/) as string,
    });
  });
});
