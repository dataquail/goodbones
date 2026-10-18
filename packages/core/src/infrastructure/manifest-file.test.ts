import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ConfigInvalid } from "../domain/architecture-error.js";
import {
  findManifestFile,
  formatManifestYaml,
  MANIFEST_FILENAMES,
  readManifestFile,
} from "./manifest-file.js";

// Inside the package rather than the OS temp dir: Vitest resolves a module
// manifest's dynamic import through its own module graph, which does not
// reach outside the project root.
const scratch = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.tmp-manifest-file",
);

mkdirSync(scratch, { recursive: true });

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

let counter = 0;

const repo = (files: Readonly<Record<string, string>>): string => {
  counter += 1;
  const root = path.join(scratch, `repo-${String(counter)}`);
  mkdirSync(root, { recursive: true });

  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, name), text);

  return root;
};

const YAML = `resolve:
  scopes:
    - files: ""
      language: typescript
tree:
  "src/":
    children: {}
    members:
      - subject: calls
        message: "no fs"
        match: ["*Sync"]
`;

describe("findManifestFile", () => {
  it("finds each of the four names", () => {
    for (const name of MANIFEST_FILENAMES) {
      const root = repo({ [name]: "" });
      expect(findManifestFile(root)).toBe(path.join(root, name));
    }
  });

  it("names all four when none is present", () => {
    const root = repo({});
    expect(() => findManifestFile(root)).toThrow(
      /no architecture manifest found.*architecture\.yaml, architecture\.yml, architecture\.json, architecture\.config\.mjs/,
    );
  });

  it("refuses a repository with more than one, naming them", () => {
    const root = repo({ "architecture.yaml": "", "architecture.config.mjs": "" });
    expect(() => findManifestFile(root)).toThrow(
      /more than one architecture manifest.*\(architecture\.yaml, architecture\.config\.mjs\)/,
    );
  });
});

describe("readManifestFile", () => {
  it("reads YAML, and hands back a locator", async () => {
    const root = repo({ "architecture.yaml": YAML });
    const read = await readManifestFile(path.join(root, "architecture.yaml"));
    expect(read.manifest).toEqual({
      resolve: { scopes: [{ files: "", language: "typescript" }] },
      tree: {
        "src/": {
          children: {},
          members: [{ subject: "calls", message: "no fs", match: ["*Sync"] }],
        },
      },
    });
    expect(read.locate).toBeDefined();
  });

  it("reads JSON through the same parser, positions included", async () => {
    const root = repo({
      "architecture.json":
        '{\n\t"resolve": { "scopes": [] },\n\t"tree": {\n\t\t"src/": { "children": {} }\n\t}\n}\n',
    });

    const read = await readManifestFile(path.join(root, "architecture.json"));
    expect(read.manifest).toEqual({ resolve: { scopes: [] }, tree: { "src/": { children: {} } } });
    expect(read.locate?.(["tree", "src/"])).toEqual({ line: 4, column: 3 });
  });

  it("reads a module's default export, with no locator", async () => {
    const root = repo({ "architecture.config.mjs": "export default { tree: {} };" });
    const read = await readManifestFile(path.join(root, "architecture.config.mjs"));
    expect(read.manifest).toEqual({ tree: {} });
    expect(read.locate).toBeUndefined();
  });

  it("refuses an extension it does not read", async () => {
    const root = repo({ "architecture.toml": "" });
    await expect(readManifestFile(path.join(root, "architecture.toml"))).rejects.toThrow(
      /a manifest is a \.yaml, \.yml or \.json file, or a \.mjs\/\.js module — not "architecture\.toml"/,
    );
  });

  it("reports a YAML syntax error with its line and column", async () => {
    const root = repo({ "architecture.yaml": "tree:\n  src/: {\n" });
    await expect(readManifestFile(path.join(root, "architecture.yaml"))).rejects.toThrow(
      /does not parse:\n {2}architecture\.yaml:\d+:\d+ {2}/,
    );
  });

  it("refuses a duplicate key rather than letting the last one win", async () => {
    const root = repo({ "architecture.yaml": "tree: {}\ntree: {}\n" });
    await expect(readManifestFile(path.join(root, "architecture.yaml"))).rejects.toThrow(
      /architecture\.yaml:2:1 {2}DUPLICATE_KEY/,
    );
  });

  it("refuses a tag it does not know", async () => {
    const root = repo({ "architecture.yaml": "tree: !!js/function 'x'\n" });
    await expect(readManifestFile(path.join(root, "architecture.yaml"))).rejects.toThrow(
      /TAG_RESOLVE_FAILED/,
    );
  });

  it("reads a bare `on`, `yes` or `no` as a string, as YAML 1.2 does", async () => {
    const root = repo({ "architecture.yaml": "tree:\n  on: yes\n  off: no\n" });
    const read = await readManifestFile(path.join(root, "architecture.yaml"));
    expect(read.manifest).toEqual({ tree: { on: "yes", off: "no" } });
  });

  it("resolves an anchor and a merge key before the manifest sees the document", async () => {
    const root = repo({
      "architecture.yaml":
        'defs:\n  floor: &floor\n    allow: ["node:**"]\ntree:\n  src/:\n    imports:\n      <<: *floor\n      message: m\n',
    });

    const read = await readManifestFile(path.join(root, "architecture.yaml"));
    expect(
      (read.manifest as { tree: { "src/": { imports: unknown } } }).tree["src/"].imports,
    ).toEqual({
      allow: ["node:**"],
      message: "m",
    });
  });

  it("wraps an unreadable file in ConfigInvalid", async () => {
    await expect(readManifestFile(path.join(scratch, "missing.yaml"))).rejects.toBeInstanceOf(
      ConfigInvalid,
    );
  });
});

describe("the YAML locator", () => {
  const locatorFor = async (text: string) => {
    const root = repo({ "architecture.yaml": text });
    const read = await readManifestFile(path.join(root, "architecture.yaml"));

    if (read.locate === undefined) throw new Error("no locator");

    return read.locate;
  };

  it("points at a map key, where the reader's eye lands", async () => {
    const locate = await locatorFor(YAML);
    expect(locate(["tree", "src/", "members", 0, "subject"])).toEqual({ line: 9, column: 9 });
    expect(locate(["tree", "src/", "members", 0, "message"])).toEqual({ line: 10, column: 9 });
  });

  it("points at a sequence item", async () => {
    const locate = await locatorFor(YAML);
    expect(locate(["tree", "src/", "members", 0])).toEqual({ line: 9, column: 9 });
    expect(locate(["tree", "src/", "members", 0, "match", 0])).toEqual({ line: 11, column: 17 });
  });

  it("answers with the nearest ancestor for a path the file does not contain", async () => {
    const locate = await locatorFor(YAML);
    expect(locate(["tree", "src/", "members", 0, "probe"])).toEqual({ line: 9, column: 9 });
    expect(locate(["tree", "src/", "members", 3])).toEqual({ line: 8, column: 5 });
    expect(locate(["nowhere"])).toEqual({ line: 1, column: 1 });
  });

  it("follows an alias to the node it names", async () => {
    const locate = await locatorFor(
      "defs:\n  rule: &rule\n    subject: calls\ntree:\n  src/:\n    members:\n      - *rule\n",
    );

    expect(locate(["tree", "src/", "members", 0, "subject"])).toEqual({ line: 3, column: 5 });
  });
});

describe("formatManifestYaml", () => {
  it("quotes a glob YAML would read as an alias, and blocks a multi-line string", () => {
    const text = formatManifestYaml({
      tree: { "src/": { members: [{ match: ["*Sync"], probe: { source: "a\nb\n" } }] } },
    });

    expect(text).toContain('- "*Sync"');
    expect(text).toContain("source: |\n");
  });
});
