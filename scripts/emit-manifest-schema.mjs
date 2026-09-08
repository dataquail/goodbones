// Writes the JSON Schemas, each generated from the Effect codec that decodes
// its document, to packages/core/schema/: the whole manifest, one node of its
// tree for a file the manifest includes, and the conformance snapshot. Run
// after a build of the core; a test in the core (`manifest/json-schema.test.ts`,
// `domain/snapshot.test.ts`) fails when a committed file falls behind the
// codec, which is how the two are kept in step.
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  atlasJsonSchema,
  manifestJsonSchema,
  manifestNodeJsonSchema,
  snapshotJsonSchema,
} from "../packages/core/build/esm/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemas = [
  ["architecture.schema.json", manifestJsonSchema()],
  ["architecture-node.schema.json", manifestNodeJsonSchema()],
  ["conformance.schema.json", snapshotJsonSchema()],
  ["atlas.schema.json", atlasJsonSchema()],
];
for (const [name, schema] of schemas) {
  const at = path.join(root, "packages/core/schema", name);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, `${JSON.stringify(schema, null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(root, at)}\n`);
}
