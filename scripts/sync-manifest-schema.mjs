// Copies the JSON Schemas into the docs site's static files, so each is
// served at the stable URL a manifest's `$schema` header, or a snapshot's
// `$id`, names. Run before every website build and dev server; the copies are
// not committed.
import { copyFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [
  "architecture.schema.json",
  "architecture-node.schema.json",
  "conformance.schema.json",
  "atlas.schema.json",
]) {
  const from = path.join(root, "packages/core/schema", name);
  const to = path.join(root, "website/public/schema", name);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}
