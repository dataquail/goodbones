// Writes the manifest's JSON Schemas, generated from the Effect codec that
// decodes it, to packages/core/schema/: the whole manifest, and one node of
// its tree for a file the manifest includes. Run after a build of the core; a
// test in the core (`manifest/json-schema.test.ts`) fails when a committed
// file falls behind the codec, which is how the two are kept in step.
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { manifestJsonSchema, manifestNodeJsonSchema } from "../packages/core/build/esm/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemas = [
  ["architecture.schema.json", manifestJsonSchema()],
  ["architecture-node.schema.json", manifestNodeJsonSchema()],
];
for (const [name, schema] of schemas) {
  const at = path.join(root, "packages/core/schema", name);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, `${JSON.stringify(schema, null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(root, at)}\n`);
}
