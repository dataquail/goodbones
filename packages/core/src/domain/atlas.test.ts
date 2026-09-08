import { Ajv2020 } from "ajv/dist/2020.js";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import {
  type Atlas,
  ATLAS_SCHEMA_ID,
  atlasJsonSchema,
  decodeAtlas,
  isExternalTarget,
} from "./atlas.js";

// The committed copy of the schema is checked against this generator in
// `manifest/json-schema.test.ts`, beside the manifest's: this tier reads no
// file, its tests included.

// A document with something in every section: two tiers, one admitted edge,
// one violation, one ungoverned edge, one package, one slack allowance.
export const SAMPLE: Atlas = {
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
        { kind: "allow", entry: "vendor/**", fragment: "floor" },
      ],
    },
    {
      path: "src/domain/",
      name: "src/domain",
      parent: "src",
      kind: "folder",
      selector: "^src/domain/",
      layout: "open",
      unrestricted: false,
      partial: false,
      families: ["imports", "structure"],
      allowances: [{ kind: "allow", entry: "src/domain/**" }],
      file: "src/architecture.yaml",
    },
  ],
  files: [
    {
      path: "src/domain/user.ts",
      node: "src/domain",
      reach: { imports: true, structure: "open", members: false, surface: false, graph: true },
      external: false,
    },
    {
      path: "src/server.ts",
      node: "src",
      reach: { imports: true, structure: "open", members: false, surface: false, graph: true },
      external: false,
    },
    {
      path: "scripts/build.ts",
      node: null,
      reach: { imports: false, structure: null, members: false, surface: false, graph: false },
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
      from: "src/server.ts",
      to: "src/domain/user.ts",
      status: "admitted",
      admittedBy: { node: "src", kind: "allow", entry: "src/**" },
    },
    {
      from: "src/domain/user.ts",
      to: "pkg:effect",
      status: "violation",
      violations: ["import|src/domain/imports|src/domain/user.ts|node_modules/effect/index.js"],
    },
    { from: "scripts/build.ts", to: "src/server.ts", status: "ungoverned" },
  ],
  designed: [
    {
      node: "src",
      allowance: { kind: "allow", entry: "src/**" },
      targets: ["src/domain/user.ts", "src/server.ts"],
      used: true,
    },
    {
      node: "src",
      allowance: { kind: "allow", entry: "vendor/**", fragment: "floor" },
      targets: [],
      used: false,
    },
  ],
  violations: [
    {
      fingerprint: "import|src/domain/imports|src/domain/user.ts|node_modules/effect/index.js",
      kind: "import",
      ruleName: "src/domain/imports",
      file: "src/domain/user.ts",
      subject: "node_modules/effect/index.js",
      message: "…",
      baselined: false,
    },
    {
      fingerprint: "graph|pure|src/server.ts|src/domain/user.ts",
      kind: "graph",
      ruleName: "pure",
      file: "src/server.ts",
      subject: "src/domain/user.ts",
      message: "…",
      baselined: true,
      route: ["src/server.ts", "src/domain/user.ts"],
    },
  ],
  cycles: [["src/domain/user.ts", "src/server.ts"]],
  unresolved: [{ file: "src/server.ts", specifier: "ghost", detail: "not found" }],
};

describe("the atlas document", () => {
  it("decodes what it encodes", () => {
    const decoded = decodeAtlas(JSON.parse(JSON.stringify(SAMPLE)) as unknown);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) expect(decoded.success).toEqual(SAMPLE);
  });

  it("refuses a key the shape does not declare, and a version it does not know", () => {
    expect(Result.isFailure(decodeAtlas({ ...SAMPLE, extra: 1 }))).toBe(true);
    expect(Result.isFailure(decodeAtlas({ ...SAMPLE, version: 2 }))).toBe(true);
    expect(
      Result.isFailure(
        decodeAtlas({
          ...SAMPLE,
          edges: [{ from: "a", to: "b", status: "designed" }],
        }),
      ),
    ).toBe(true);
  });

  it("publishes a JSON Schema the sample validates against, at its own URL", () => {
    const schema = atlasJsonSchema();
    expect(schema.$id).toBe(ATLAS_SCHEMA_ID);
    expect(ATLAS_SCHEMA_ID).toMatch(/^https:\/\/dataquail\.github\.io\/goodbones\/schema\//);
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    expect(validate(JSON.parse(JSON.stringify(SAMPLE))), JSON.stringify(validate.errors)).toBe(
      true,
    );
    expect(validate({ ...SAMPLE, cycles: "one" })).toBe(false);
  });

  it("tells a package or builtin from a file by its prefix", () => {
    expect(isExternalTarget("pkg:effect")).toBe(true);
    expect(isExternalTarget("builtin:node:fs")).toBe(true);
    expect(isExternalTarget("src/pkg:x.ts")).toBe(false);
  });
});
