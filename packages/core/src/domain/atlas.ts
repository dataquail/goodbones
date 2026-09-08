import * as Schema from "effect/Schema";

import { LoweredNode } from "./architecture-config.js";
import { SnapshotViolation } from "./snapshot.js";

// The atlas: one JSON document per run holding the tree as it is — every
// file the walker saw, every edge the resolver resolved — with the manifest
// laid over it: which edges the policy admits and through which allowance,
// which it forbids, and which it has nothing to say about. The conformance
// snapshot keeps the counts; this keeps the things counted. `architecture
// atlas` emits it, and it is the only thing either renderer reads — the
// mermaid diagram and the explorer are two views of one document. A wire
// format, so it is defined here with a schema before anything consumes it,
// and versioned so a document that grows it can say which one it grew.

export const ATLAS_SCHEMA_ID = "https://dataquail.github.io/goodbones/schema/atlas.schema.json";

export const ATLAS_VERSION = 1;

const describe = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description });

const Path = describe(Schema.String, "Repo-relative, with forward slashes.");

// A target outside the walk — a package, a runtime module — is a node of the
// graph like any file, so the roll-up has one kind of thing to roll up and a
// folder can say what it pulls in from outside. Named so it can never collide
// with a path: `pkg:effect`, `builtin:node:fs`.
export const PACKAGE_PREFIX = "pkg:";
export const BUILTIN_PREFIX = "builtin:";

const Target = describe(
  Schema.String,
  "A walked file's path, `pkg:<name>` for a package, or `builtin:<name>` for a runtime module.",
);

const AllowanceKind = describe(
  Schema.Literals(["allow", "external"]),
  "`allow` is a path glob under `imports.allow`; `external` a package name under `imports.external`.",
);

// One entry of an allowlist as the atlas names it: which kind, what was
// written, and the `defs` fragment it came through when it came through one.
export const AtlasAllowance = Schema.Struct({
  kind: AllowanceKind,
  entry: describe(Schema.String, "The entry as written, after alias expansion."),
  fragment: Schema.optionalKey(
    describe(Schema.String, "The `defs` fragment the entry arrived through, via `use`."),
  ),
});

export const AtlasNode = Schema.Struct({
  ...LoweredNode.fields,
  allowances: describe(
    Schema.Array(AtlasAllowance),
    "The import allowances this node wrote itself, in manifest order. Inherited ones are on the ancestor that wrote them.",
  ),
});

const EdgeStatus = describe(
  Schema.Literals(["admitted", "violation", "ungoverned"]),
  "`admitted`: the importer is under an import allowlist and an allowance matched the target. `violation`: an import rule fired. `ungoverned`: no import allowlist selects the importer, so the policy has nothing to say.",
);

export const AtlasFile = Schema.Struct({
  path: Target,
  node: describe(
    Schema.NullOr(Schema.String),
    "The `name` of the deepest manifest node whose selector matches the file, or null when the tree does not reach it. Always null for a package or builtin.",
  ),
  reach: describe(
    Schema.Struct({
      imports: Schema.Boolean,
      structure: Schema.NullOr(Schema.Literals(["enumerated", "open"])),
      members: Schema.Boolean,
      surface: Schema.Boolean,
      graph: Schema.Boolean,
    }),
    "Which families reach the file — `coverage`'s per-file record. A file none reaches is residue.",
  ),
  external: describe(Schema.Boolean, "True for a package or builtin pseudo-file."),
});

export const AtlasEdge = Schema.Struct({
  from: Path,
  to: Target,
  status: EdgeStatus,
  admittedBy: Schema.optionalKey(
    describe(
      Schema.Struct({
        node: describe(Schema.String, "The `name` of the node that wrote the allowance."),
        ...AtlasAllowance.fields,
      }),
      "With `admitted`: the allowance that let the edge through — the one written nearest the importer when several did.",
    ),
  ),
  violations: Schema.optionalKey(
    describe(
      Schema.Array(Schema.String),
      "Fingerprints of the violations on this edge: the import rule that fired, and any exports rule about a name carried across it.",
    ),
  ),
});

export const DesignedEdge = Schema.Struct({
  node: describe(Schema.String, "The `name` of the node the allowance is in force at."),
  allowance: AtlasAllowance,
  targets: describe(
    Schema.Array(Target),
    "The walked files the entry matches, from the files the node selects; `pkg:<name>` for an `external`.",
  ),
  used: describe(
    Schema.Boolean,
    "Whether any observed edge passes through the allowance. False is slack: permission nothing needs, drawn as a ghost edge.",
  ),
});

export const Atlas = Schema.Struct({
  version: describe(Schema.Literal(ATLAS_VERSION), "The shape of this document."),
  manifest: describe(
    Schema.Struct({
      path: describe(Path, "The file the policy was read from — the root file, when split."),
      sha256: describe(Schema.String, "A hash of that file's bytes."),
    }),
    "The policy this atlas was drawn against.",
  ),
  roots: describe(Schema.Array(Path), "The directories walked."),
  nodes: describe(
    Schema.Array(AtlasNode),
    "The manifest's tree, flattened in manifest order, each node with the pattern that selects its files and the allowances it wrote.",
  ),
  files: describe(
    Schema.Array(AtlasFile),
    "Every walked file and every local file some edge reaches outside the walk, sorted, then every package and builtin some edge reaches.",
  ),
  edges: describe(
    Schema.Array(AtlasEdge),
    "Every resolved import, one per (importer, target) pair, with its status under the policy.",
  ),
  designed: describe(
    Schema.Array(DesignedEdge),
    "Every allowance in force at a node with files, resolved against the walk. An allowance with no observed edge under it is slack; an observed edge with no designed edge over it is ungoverned or a violation.",
  ),
  violations: describe(
    Schema.Array(SnapshotViolation),
    "Every finding, baselined ones included, as the conformance snapshot lists them.",
  ),
  cycles: describe(
    Schema.Array(Schema.Array(Path)),
    "Every strongly connected component of more than one file, or a file importing itself, each sorted.",
  ),
  unresolved: describe(
    Schema.Array(Schema.Struct({ file: Path, specifier: Schema.String, detail: Schema.String })),
    "Imports the resolver could not turn into a file, from files under an import rule. Not edges.",
  ),
});

export type Atlas = typeof Atlas.Type;
export type AtlasNode = typeof AtlasNode.Type;
export type AtlasFile = typeof AtlasFile.Type;
export type AtlasEdge = typeof AtlasEdge.Type;
export type AtlasEdgeStatus = AtlasEdge["status"];
export type AtlasAllowance = typeof AtlasAllowance.Type;
export type DesignedEdge = typeof DesignedEdge.Type;

// Decodes a document some other run wrote, refusing a key the shape does not
// declare, so a consumer never reads a field a later version renamed.
export const decodeAtlas = Schema.decodeUnknownResult(Atlas, {
  errors: "all",
  onExcessProperty: "error",
});

// Whether a target names something outside the walk.
export const isExternalTarget = (target: string): boolean =>
  target.startsWith(PACKAGE_PREFIX) || target.startsWith(BUILTIN_PREFIX);

type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
type JsonObject = { readonly [key: string]: JsonValue };

// The document's shape as a JSON Schema, generated from the same codec, so
// the two cannot disagree. Published beside the manifest's and the snapshot's.
export const atlasJsonSchema = (): JsonObject => {
  const generated = Schema.toJsonSchemaDocument(Atlas) as unknown as {
    readonly schema: JsonObject;
    readonly definitions: JsonObject;
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: ATLAS_SCHEMA_ID,
    title: "Architecture atlas",
    description:
      "A repository's walked tree and resolved import graph with its architecture manifest laid over it, as `architecture atlas` emits it. See https://dataquail.github.io/goodbones/architecture-rules/enforcement/diagram/.",
    ...generated.schema,
    ...(Object.keys(generated.definitions).length === 0 ? {} : { $defs: generated.definitions }),
  };
};
