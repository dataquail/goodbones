import { Ajv2020 } from "ajv/dist/2020.js";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import {
  decodeSnapshot,
  type Snapshot,
  SNAPSHOT_SCHEMA_ID,
  snapshotJsonSchema,
} from "./snapshot.js";

// The committed copy of the schema is checked against this generator in
// `manifest/json-schema.test.ts`, beside the manifest's: this tier reads no
// file, its tests included.

// A document with something in every section.
const SAMPLE: Snapshot = {
  version: 1,
  manifest: { path: "architecture.yaml", sha256: "abc" },
  roots: ["src"],
  files: 3,
  ok: false,
  coverage: {
    imports: { covered: 2, total: 3, floor: 1 },
    structure: { covered: 0, total: 3 },
    members: { covered: 1, total: 3 },
    surface: { covered: 3, total: 3 },
    graph: { covered: 0, total: 3 },
  },
  residue: { files: ["src/stray.ts"], folders: [] },
  vacant: [{ node: "src/ghost", allowances: 2 }],
  violations: [
    {
      fingerprint: "import|src/imports|src/a.ts|lib/b.ts",
      kind: "import",
      ruleName: "src/imports",
      file: "src/a.ts",
      subject: "lib/b.ts",
      message: "…",
      baselined: false,
    },
    {
      fingerprint: "structure|src/layout|src/x.ts|",
      kind: "structure",
      ruleName: "src/layout",
      file: "src/x.ts",
      subject: null,
      message: "…",
      baselined: true,
    },
  ],
  unresolved: [{ file: "src/a.ts", specifier: "ghost", detail: "not found" }],
  stale: ["member|m|src/gone.ts|x"],
  baseline: { size: 2 },
  cycles: 1,
  slack: [
    { node: "src", kind: "external", entry: "lodash" },
    { node: "test-file", kind: "external", entry: "stripe", fragment: "test-file", of: 24 },
  ],
  concentration: [
    { fragment: "test-file", kind: "external", entry: "@effect/sql-pg", usedAt: 1, of: 24 },
  ],
  adoption: { unrestricted: ["src/legacy"], partial: [] },
};

const validator = () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(snapshotJsonSchema());
};

describe("the conformance snapshot", () => {
  it("names itself at the URL the docs site publishes", () => {
    expect(snapshotJsonSchema().$id).toBe(SNAPSHOT_SCHEMA_ID);
    expect(SNAPSHOT_SCHEMA_ID).toMatch(/^https:\/\/dataquail\.github\.io\/goodbones\/schema\//);
  });

  it("validates a document with every section filled, through the JSON Schema and the codec", () => {
    const validate = validator();
    expect(validate(SAMPLE), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(Result.isSuccess(decodeSnapshot(SAMPLE))).toBe(true);
  });

  // A consumer reads the schema before the code, so every top-level field
  // says what it is. The generator puts a description on the node or, for a
  // refined number, inside an `allOf`; either counts.
  it("describes every top-level field", () => {
    const schema = snapshotJsonSchema() as {
      properties: Record<string, { description?: string; allOf?: Array<{ description?: string }> }>;
    };
    const described = (field: string): boolean => {
      const node = schema.properties[field];
      return (
        node !== undefined &&
        (node.description !== undefined ||
          (node.allOf ?? []).some((one) => one.description !== undefined))
      );
    };
    for (const field of Object.keys(SAMPLE)) expect(described(field), field).toBe(true);
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(SAMPLE).sort());
  });

  it("refuses a key the shape does not declare, and a version it does not know", () => {
    const validate = validator();
    expect(validate({ ...SAMPLE, extra: 1 })).toBe(false);
    expect(validate({ ...SAMPLE, version: 2 })).toBe(false);
    expect(Result.isFailure(decodeSnapshot({ ...SAMPLE, extra: 1 }))).toBe(true);
    expect(Result.isFailure(decodeSnapshot({ ...SAMPLE, version: 2 }))).toBe(true);
  });

  it("refuses a violation of an unknown kind or a slack of an unknown kind", () => {
    const validate = validator();
    expect(
      validate({
        ...SAMPLE,
        violations: [{ ...SAMPLE.violations[0], kind: "imports" }],
      }),
    ).toBe(false);
    expect(validate({ ...SAMPLE, slack: [{ node: "src", kind: "deny", entry: "x" }] })).toBe(false);
  });
});
