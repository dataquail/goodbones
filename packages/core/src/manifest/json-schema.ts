import * as Schema from "effect/Schema";

import { Manifest } from "./manifest.js";

// The manifest's shape as a JSON Schema, generated from the same codec that
// decodes it, so the two cannot disagree. A YAML file names it in a header
// comment and a JSON file in a `$schema` key; either way the editor completes
// keys and flags a misspelled one before the loader ever runs.
//
// Three things the codec does not know are added here: the `defs` map, the
// `{ use }` reference form that may stand in for any object, and the
// `{ include }` form that may stand in for any object or list — all belong to
// the passes that run before decoding.

export const MANIFEST_SCHEMA_ID =
  "https://dataquail.github.io/goodbones/schema/architecture.schema.json";

// The schema an included file names: one node of the tree, with the two keys
// a file of its own may carry at the top.
export const MANIFEST_NODE_SCHEMA_ID =
  "https://dataquail.github.io/goodbones/schema/architecture-node.schema.json";

type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
type JsonObject = { readonly [key: string]: JsonValue };

const entriesOf = (value: JsonObject): ReadonlyArray<readonly [string, JsonValue]> =>
  Object.entries(value);

const isObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isList = (value: JsonValue): value is ReadonlyArray<JsonValue> => Array.isArray(value);

// The generator names the recursive node after its own internal wrapper. A
// stable name is what a `$ref` in an error message or a docs page can point at.
const DEFINITION_NAMES: Readonly<Record<string, string>> = { Suspend_: "ManifestNode" };

const USE_REFERENCE = "#/$defs/Use";
const INCLUDE_REFERENCE = "#/$defs/Include";

const Use: JsonObject = {
  type: "object",
  description:
    "A reference to a fragment under the top-level `defs`. Replaced by a copy of the fragment before the manifest is decoded; any other key written beside `use` overrides the fragment's key of the same name.",
  properties: { use: { type: "string" } },
  required: ["use"],
};

const Include: JsonObject = {
  type: "object",
  description:
    "A reference to another YAML or JSON file, relative to this one. Replaced by that file's whole value before the manifest is decoded; a list item naming a file that holds a list is spliced in. Nothing may be written beside `include`.",
  properties: { include: { type: "string" } },
  required: ["include"],
  additionalProperties: false,
};

// Every object schema below the root becomes "this object, or a `use` of a
// fragment shaped like it, or an `include` of a file holding one", and every
// list schema "this list, or an `include` of a file holding one". The
// expansion passes replace a reference wherever it stands, so the schema
// admits one wherever the value may stand.
const admitReferences = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(admitReferences);
  if (!isObject(value)) return value;

  const rebuilt: Record<string, JsonValue> = {};
  for (const [key, entry] of entriesOf(value)) {
    if (key === "$ref" && typeof entry === "string") {
      const name = entry.replace(/^#\/\$defs\//, "");
      rebuilt[key] = `#/$defs/${DEFINITION_NAMES[name] ?? name}`;
    } else {
      rebuilt[key] = admitReferences(entry);
    }
  }
  if (rebuilt.type === "object" && "properties" in rebuilt) {
    return { anyOf: [{ $ref: USE_REFERENCE }, { $ref: INCLUDE_REFERENCE }, rebuilt] };
  }
  if (rebuilt.type === "array") {
    return { anyOf: [{ $ref: INCLUDE_REFERENCE }, rebuilt] };
  }
  return rebuilt;
};

const DEFS_PROPERTY: JsonObject = {
  type: "object",
  description:
    'Named fragments, referenced elsewhere in the manifest as `{ use: "<name>" }`. A fragment may itself contain `use`. Every file\'s `defs` share one namespace.',
  additionalProperties: true,
};

const SCHEMA_PROPERTY: JsonObject = {
  type: "string",
  description: "For editors. Ignored by the loader.",
};

export const manifestJsonSchema = (): JsonObject => {
  const generated = Schema.toJsonSchemaDocument(Manifest) as unknown as {
    readonly schema: JsonObject;
    readonly definitions: JsonObject;
  };
  const { properties, ...root } = generated.schema;
  if (properties === undefined || !isObject(properties)) {
    throw new Error("the manifest schema generated with no properties");
  }

  const definitions: Record<string, JsonValue> = {};
  for (const [name, definition] of entriesOf(generated.definitions)) {
    definitions[DEFINITION_NAMES[name] ?? name] = admitReferences(definition);
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: MANIFEST_SCHEMA_ID,
    title: "Architecture manifest",
    description:
      "One manifest of a repository's architecture, read by @goodbones/cli and @goodbones/oxlint. See https://dataquail.github.io/goodbones/architecture-rules/manifest/.",
    ...root,
    properties: {
      $schema: SCHEMA_PROPERTY,
      defs: DEFS_PROPERTY,
      ...Object.fromEntries(
        entriesOf(properties).map(([key, value]) => [key, admitReferences(value)]),
      ),
    },
    $defs: { ...definitions, Use, Include },
  };
};

// One node of the tree as a file of its own — what a per-package
// `architecture.yaml` that the root manifest `include`s is shaped like. The
// node's object form, with the `$schema` and `defs` keys such a file may carry
// at the top, over the same definitions as the whole manifest.
export const manifestNodeJsonSchema = (): JsonObject => {
  const whole = manifestJsonSchema();
  const definitions = whole.$defs;
  if (definitions === undefined || !isObject(definitions)) {
    throw new Error("the manifest schema generated with no definitions");
  }
  const node = definitions.ManifestNode;
  const variants = node !== undefined && isObject(node) ? node.anyOf : undefined;
  const object =
    variants !== undefined && isList(variants)
      ? variants.find((variant) => isObject(variant) && variant.type === "object")
      : undefined;
  if (object === undefined || !isObject(object)) {
    throw new Error("the manifest schema generated with no object form of a node");
  }
  const { $id: _id, $schema: _schema, ...rest } = object;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: MANIFEST_NODE_SCHEMA_ID,
    title: "Architecture manifest node",
    description:
      "One node of an architecture manifest's tree, as a file the manifest includes. See https://dataquail.github.io/goodbones/architecture-rules/manifest/#splitting-the-manifest-include.",
    ...rest,
    properties: {
      $schema: SCHEMA_PROPERTY,
      defs: DEFS_PROPERTY,
      ...(rest.properties !== undefined && isObject(rest.properties) ? rest.properties : {}),
    },
    $defs: definitions,
  };
};
