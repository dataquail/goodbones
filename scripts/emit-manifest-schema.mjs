// Writes the JSON Schemas, each generated from the Effect codec that decodes
// its document, to packages/core/schema/: the whole manifest, one node of its
// tree for a file the manifest includes, and the conformance snapshot. Run
// after a build of the core; a test in the core (`manifest/json-schema.test.ts`,
// `domain/snapshot.test.ts`) fails when a committed file falls behind the
// codec, which is how the two are kept in step.
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CampaignsManifest } from "../packages/campaigns/build/esm/index.js";
import {
  manifestJsonSchema,
  manifestNodeJsonSchema,
  snapshotJsonSchema,
} from "../packages/core/build/esm/index.js";

// The manifest schema an editor fetches is the COMPOSED one: the core's keys
// and those of every family the `architecture` bin loads. Today that is one
// family, so the campaigns codec's fields are generated alongside the core's.
// The node schema is a tree node, which no family extends, so it stays the
// core's alone.
const extensions = [CampaignsManifest.fields];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemas = [
  ["architecture.schema.json", manifestJsonSchema({ extensions })],
  ["architecture-node.schema.json", manifestNodeJsonSchema()],
  ["conformance.schema.json", snapshotJsonSchema()],
];
for (const [name, schema] of schemas) {
  const at = path.join(root, "packages/core/schema", name);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, `${JSON.stringify(schema, null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(root, at)}\n`);
}
