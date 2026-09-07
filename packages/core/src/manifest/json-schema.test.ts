import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { snapshotJsonSchema } from "../domain/snapshot.js";
import {
  MANIFEST_NODE_SCHEMA_ID,
  MANIFEST_SCHEMA_ID,
  manifestJsonSchema,
  manifestNodeJsonSchema,
} from "./json-schema.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const committed = path.join(root, "packages/core/schema/architecture.schema.json");
const committedNode = path.join(root, "packages/core/schema/architecture-node.schema.json");
const committedSnapshot = path.join(root, "packages/core/schema/conformance.schema.json");

const validator = () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(manifestJsonSchema());
};

const nodeValidator = () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(manifestNodeJsonSchema());
};

// The per-package files this repository's own manifest includes.
const includedNodes = readdirSync(path.join(root, "packages"))
  .map((name) => path.join(root, "packages", name, "architecture.yaml"))
  .filter((file) => existsSync(file));

describe("the manifest JSON Schema", () => {
  // The committed file is what the docs site publishes and what an editor
  // fetches. It is generated, and this is what says when it is stale.
  it("is what packages/core/schema/architecture.schema.json holds", () => {
    const expected = `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`;
    expect(readFileSync(committed, "utf8")).toBe(expected);
  });

  it("names itself at the URL the docs site publishes", () => {
    expect(manifestJsonSchema().$id).toBe(MANIFEST_SCHEMA_ID);
    expect(MANIFEST_SCHEMA_ID).toMatch(/^https:\/\/dataquail\.github\.io\/goodbones\/schema\//);
  });

  it("validates this repository's own manifest, defs, use and include included", () => {
    const validate = validator();
    const manifest: unknown = parse(readFileSync(path.join(root, "architecture.yaml"), "utf8"));
    expect(validate(manifest), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("admits an include wherever an object or a list may stand", () => {
    const validate = validator();
    expect(
      validate({
        defs: { include: "defs.yaml" },
        resolve: { scopes: [] },
        exports: { include: "exports.yaml" },
        graph: { cycles: [{ include: "cycles.yaml" }] },
        tree: {
          "src/": { include: "src.yaml" },
          "lib/": { imports: { include: "floor.yaml" }, members: [{ include: "rule.yaml" }] },
        },
      }),
      JSON.stringify(validate.errors, null, 2),
    ).toBe(true);
  });

  it("rejects a key beside include", () => {
    const validate = validator();
    expect(
      validate({
        resolve: { scopes: [] },
        tree: { "src/": { include: "src.yaml", layout: "open" } },
      }),
    ).toBe(false);
  });

  it("rejects a misspelled key", () => {
    const validate = validator();
    expect(
      validate({
        resolve: { scopes: [] },
        tree: {
          "src/": { children: {}, members: [{ message: "m", subject: "calls", matchNott: "x" }] },
        },
      }),
    ).toBe(false);
    expect(JSON.stringify(validate.errors)).toContain("matchNott");
  });

  it("rejects a value outside its enum", () => {
    const validate = validator();
    expect(validate({ resolve: { scopes: [] }, tree: { "src/": { layout: "closed" } } })).toBe(
      false,
    );
  });

  it("admits a use with overrides wherever an object may stand, and a $schema key", () => {
    const validate = validator();
    expect(
      validate({
        $schema: MANIFEST_SCHEMA_ID,
        defs: { floor: { allow: ["node:**"] }, rule: { message: "m", subject: "calls" } },
        resolve: { scopes: [] },
        graph: { cycles: [{ use: "rule" }] },
        tree: {
          "src/": { use: "node" },
          "lib/": {
            imports: { use: "floor", message: "m" },
            members: [{ use: "rule", except: ["x"] }],
          },
        },
      }),
      JSON.stringify(validate.errors, null, 2),
    ).toBe(true);
  });

  it("names the recursive node", () => {
    const schema = manifestJsonSchema() as { $defs: Record<string, unknown> };
    expect(Object.keys(schema.$defs).sort()).toEqual(["Include", "ManifestNode", "Use"]);
  });
});

// The snapshot's schema is generated in the domain, which reads no file — so
// the check that its committed copy is current lives here, beside the others.
describe("the conformance snapshot JSON Schema", () => {
  it("is what packages/core/schema/conformance.schema.json holds", () => {
    const expected = `${JSON.stringify(snapshotJsonSchema(), null, 2)}\n`;
    expect(readFileSync(committedSnapshot, "utf8")).toBe(expected);
  });
});

describe("the node JSON Schema", () => {
  it("is what packages/core/schema/architecture-node.schema.json holds", () => {
    const expected = `${JSON.stringify(manifestNodeJsonSchema(), null, 2)}\n`;
    expect(readFileSync(committedNode, "utf8")).toBe(expected);
  });

  it("names itself beside the manifest's", () => {
    expect(manifestNodeJsonSchema().$id).toBe(MANIFEST_NODE_SCHEMA_ID);
    expect(MANIFEST_NODE_SCHEMA_ID).toMatch(
      /^https:\/\/dataquail\.github\.io\/goodbones\/schema\//,
    );
  });

  it("validates each file this repository's manifest includes", () => {
    expect(includedNodes.length).toBeGreaterThan(0);
    const validate = nodeValidator();
    for (const file of includedNodes) {
      const node: unknown = parse(readFileSync(file, "utf8"));
      expect(validate(node), `${file}\n${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
    }
  });

  it("admits the defs and $schema keys a file of its own carries, and a use below", () => {
    const validate = nodeValidator();
    expect(
      validate({
        $schema: MANIFEST_NODE_SCHEMA_ID,
        defs: { rule: { message: "m", subject: "calls" } },
        layout: "open",
        children: { "domain/": { children: {}, members: [{ use: "rule" }] } },
      }),
      JSON.stringify(validate.errors, null, 2),
    ).toBe(true);
  });

  it("rejects a misspelled key, and a whole manifest", () => {
    const validate = nodeValidator();
    expect(validate({ children: {}, layuot: "open" })).toBe(false);
    expect(validate({ resolve: { scopes: [] }, tree: {} })).toBe(false);
  });
});
