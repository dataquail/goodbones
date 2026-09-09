import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import { DeclarationKind, ResolveConfig } from "../domain/architecture-config.js";
import { ConfigInvalid } from "../domain/architecture-error.js";
import {
  type ManifestLocator,
  type ManifestPath,
  renderManifestPath,
} from "../domain/manifest-location.js";
import { expandManifest, originOf, type Substitution } from "./expand.js";

// A manifest is a tree of nodes keyed by path pattern, where everything the
// architecture says about a part of the tree is written at that part of the tree.
// A node is a folder (it has `children` and/or `files`) or a file (its key names
// a filename pattern).
//
// The default is tight: a folder admits only the children it lists, and a node
// may import only what it or an ancestor allows. Laxity is opted into, by name,
// at the node that wants it.

const Globs = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

// A prohibition. `match`/`matchNot` describe the target; `except` names the
// importers it does not apply to. The exemption is declared by the author of the
// prohibition, in the same breath — a descendant still cannot opt itself out.
const Denial = Schema.Struct({
  match: Globs,
  matchNot: Schema.optionalKey(Globs),
  except: Schema.optionalKey(Globs),
  message: Schema.String,
});

// Outbound: what this part of the tree may reach.
const Imports = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  // Repo-relative globs, after alias expansion. A target matching none of these
  // is the violation — so widening is something you do by name, in the open.
  allow: Schema.optionalKey(Globs),
  // npm package names. Omit to inherit; `[]` to forbid every external.
  external: Schema.optionalKey(Schema.Array(Schema.String)),
  // Checked before `allow`, and wins over it. This is how a rule keeps a
  // specific, better message for a mistake the allowlist would also catch.
  deny: Schema.optionalKey(Schema.Array(Denial)),
  // The one widening mechanism: stop inheriting ancestors' allowances. Inherited
  // `deny` entries are unaffected — a prohibition only ever accumulates.
  reset: Schema.optionalKey(Schema.Boolean),
  // "This tier has no allowlist yet; only the prohibitions below apply." Implies
  // `reset`. Required whenever a node states `imports` without an `allow`, so
  // that an untightened tier is a sentence someone wrote rather than a gap in
  // the config — and so `grep unrestricted` is the adoption backlog.
  unrestricted: Schema.optionalKey(Schema.Boolean),
});

// Inbound: who may reach this part of the tree. Four of the rules governing
// `domain/` are of this shape — "a root-ops file is private to command handlers" —
// and stating them here is what stops them being a distant rule with a growing
// exclusion list on its `from` side.
const ImportedBy = Schema.Struct({
  message: Schema.String,
  allow: Globs,
  // Targets inside this node's subtree the restriction does not cover — the
  // module barrel is the obvious one: a module is private except through it.
  matchNot: Schema.optionalKey(Globs),
});

// What shape the variable part of a name must have. A folder's `children` keys
// already say which stereotypes it admits; this says what the concept name in
// front of the stereotype may look like, which is the degree of freedom a
// taxonomy alone leaves open.
//
// `like` names an ancestor capture the name must equal — a subdomain folder's
// root is named after the folder, and nothing else could say so.
const Naming = Schema.Union([
  Schema.Literals(["kebab-case", "camelCase", "PascalCase", "snake_case"]),
  Schema.Struct({ regex: Schema.String, message: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ like: Schema.String, message: Schema.optionalKey(Schema.String) }),
]);

// A probe the author writes, in place of the synthetic one lowering would
// generate. `source` is parsed by the adapter at load, and the rule must report
// the named site out of what the parser read — which is the only way to state
// "this rule fires on an intersection-typed port" and have it checked, since a
// synthetic probe never meets a parser.
const MemberProbe = Schema.Struct({
  source: Schema.String,
  name: Schema.String,
});

const Members = Schema.Struct({
  message: Schema.String,
  subject: Schema.Literals(["members", "calls"]),
  in: Schema.optionalKey(Globs),
  // `members` only: which declarations are read — `type`, `interface`,
  // `class`. Omit for every kind.
  declares: Schema.optionalKey(Schema.Array(DeclarationKind)),
  match: Schema.optionalKey(Globs),
  matchNot: Schema.optionalKey(Globs),
  allow: Schema.optionalKey(Globs),
  probe: Schema.optionalKey(MemberProbe),
});

// What a file may export. The selectors say which export sites the sentence
// is about; exactly one demand says what is required of them, and none means
// `forbid` — a selected site is the violation. Stated on a folder it covers
// the subtree, like `members`.
const SurfaceConvention = Schema.Union([
  Schema.Literals(["kebab-case", "camelCase", "PascalCase", "snake_case"]),
  Schema.Struct({ regex: Schema.String }),
]);

const Surface = Schema.Struct({
  message: Schema.String,
  // `named`, `default`, `namespace` — the last is `export *` and `export * as`.
  kinds: Schema.optionalKey(Schema.Array(Schema.Literals(["named", "default", "namespace"]))),
  // What the site was declared as, for a site declared in the file.
  declares: Schema.optionalKey(Schema.Array(DeclarationKind)),
  // `true` speaks only to `export … from "m"`; `false` only to what the file
  // declares itself.
  reexport: Schema.optionalKey(Schema.Boolean),
  match: Schema.optionalKey(Globs),
  matchNot: Schema.optionalKey(Globs),
  // The demand. `forbid: true` is the default made explicit.
  forbid: Schema.optionalKey(Schema.Boolean),
  allow: Schema.optionalKey(Globs),
  convention: Schema.optionalKey(SurfaceConvention),
  count: Schema.optionalKey(
    Schema.Struct({
      min: Schema.optionalKey(Schema.Finite),
      max: Schema.optionalKey(Schema.Finite),
    }),
  ),
  // Files under this node the rule does not apply to.
  except: Schema.optionalKey(Globs),
  // A source the rule must report something out of, parsed at load.
  probe: Schema.optionalKey(Schema.Struct({ source: Schema.String })),
});

// Which importers may name a given exported symbol. A path rule cannot say
// this: every importer of a barrel resolves to the same file, so only the
// imported name separates a bus factory from the Tag beside it.
const ExportRestriction = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  // The module the symbols come from, matched against its RESOLVED path.
  module: Globs,
  // Exact exported names. Omit to mean "any named import from that module",
  // which is how a rule bans a binding form rather than a name.
  symbols: Schema.optionalKey(Schema.Array(Schema.String)),
  // Which binding forms the rule speaks to. Defaults to `["named"]` — so a rule
  // about a factory function says nothing about `import makeBus from "m"` until
  // it lists `"default"`, and nothing about `import * as m`, `export * from
  // "m"`, `import("m")` or `require("m")` until it lists `"namespace"`. A
  // namespace binding's only name is `*`, so `symbols` cannot select one.
  kinds: Schema.optionalKey(Schema.Array(Schema.Literals(["named", "default", "namespace"]))),
  except: Schema.optionalKey(Globs),
  fix: Schema.optionalKey(Schema.Literal("subpath-namespace-import")),
  // As on `members`: a snippet the adapter parses at load, every edge of which
  // is taken to reach this module, and a binding out of it the rule must cover.
  // `symbol` is `"default"` for a default import and `"*"` for a namespace one.
  probe: Schema.optionalKey(Schema.Struct({ source: Schema.String, symbol: Schema.String })),
});

export type ManifestNode = {
  readonly message?: string;
  // The architectural layer this node's files belong to — `domain`, `io`,
  // `application` — by the id `layers` declares. Inherited by the subtree
  // until a descendant names its own. The folder tree says where a file is;
  // the layer says what role it plays, which is what a vertical slice reads.
  readonly layer?: string;
  // Carry policy for the subtree without claiming to enumerate this folder's
  // contents. What makes incremental adoption possible — and what lets a
  // prototype cover one branch without rejecting every sibling.
  readonly partial?: boolean;
  // "This folder admits any source file; only its subfolders are enumerated."
  // A tier that is deliberately permissive about file names — the component
  // library is, by design — says so, rather than carrying a layout rule that
  // could never reject anything.
  readonly layout?: "open";
  // Inherited by the subtree, like `imports`, so a tier states its convention
  // once rather than on every stereotype it admits.
  readonly name?: typeof Naming.Type;
  readonly imports?: typeof Imports.Type;
  readonly importedBy?: typeof ImportedBy.Type;
  readonly members?: ReadonlyArray<typeof Members.Type>;
  readonly surface?: ReadonlyArray<typeof Surface.Type>;
  // Files this node must have beside it. `{base}` is this file's name minus its
  // final extension; `../` resolves against the node's own folder.
  readonly requires?: ReadonlyArray<string>;
  // Filenames this node's `requires` does not apply to — the exemption lives on
  // the obligation it exempts, rather than as a separate more-specific key that
  // has to win a precedence contest.
  readonly requiresNot?: ReadonlyArray<string>;
  // Folder nodes only. Deny-by-default: a child matching no key is a violation.
  readonly children?: Readonly<Record<string, ManifestNode>>;
};

const ManifestNodeSchema: Schema.Codec<ManifestNode> = Schema.suspend(() =>
  Schema.Struct({
    message: Schema.optionalKey(Schema.String),
    layer: Schema.optionalKey(Schema.String),
    partial: Schema.optionalKey(Schema.Boolean),
    layout: Schema.optionalKey(Schema.Literal("open")),
    name: Schema.optionalKey(Naming),
    imports: Schema.optionalKey(Imports),
    importedBy: Schema.optionalKey(ImportedBy),
    members: Schema.optionalKey(Schema.Array(Members)),
    surface: Schema.optionalKey(Schema.Array(Surface)),
    requires: Schema.optionalKey(Schema.Array(Schema.String)),
    requiresNot: Schema.optionalKey(Schema.Array(Schema.String)),
    children: Schema.optionalKey(Schema.Record(Schema.String, ManifestNodeSchema)),
  }),
);

// Rules about the shape of the whole import graph. Globs, like everything
// else here, expanded through `aliases`. Evaluated by the CLI only: the plugin
// sees one file at a time and cannot answer "does anything import this?".
const GraphCycles = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  within: Globs,
  withinNot: Schema.optionalKey(Globs),
});

const GraphOrphans = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  within: Globs,
  withinNot: Schema.optionalKey(Globs),
  entry: Globs,
});

const GraphReach = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  from: Globs,
  fromNot: Schema.optionalKey(Globs),
  to: Globs,
  toNot: Schema.optionalKey(Globs),
  via: Schema.optionalKey(Globs),
});

const Graph = Schema.Struct({
  cycles: Schema.optionalKey(Schema.Array(GraphCycles)),
  orphans: Schema.optionalKey(Schema.Array(GraphOrphans)),
  reach: Schema.optionalKey(Schema.Array(GraphReach)),
});

// Ratchets on the policy itself. `unrestricted` and `partial` are the two
// ways a tier says "not tightened yet"; a ceiling on how many may say so is
// what stops the backlog growing. `coverage` is a floor, per family, on the
// fraction of walked files a rule actually reaches — probes prove a rule can
// fire; this proves the tree reaches the files.
const CoverageFloors = Schema.Struct({
  imports: Schema.optionalKey(Schema.Finite),
  structure: Schema.optionalKey(Schema.Finite),
  members: Schema.optionalKey(Schema.Finite),
  surface: Schema.optionalKey(Schema.Finite),
  graph: Schema.optionalKey(Schema.Finite),
});

const Limits = Schema.Struct({
  unrestricted: Schema.optionalKey(Schema.Finite),
  partial: Schema.optionalKey(Schema.Finite),
  coverage: Schema.optionalKey(CoverageFloors),
});

// One architectural layer, declared once and named by nodes with `layer`.
// The list's order is outermost first — module, io, application, domain —
// which is the order a vertical slice reads top-down. A `tier` is a stratum
// a file sits in; an `enclosing` layer is a boundary the other layers sit
// inside — a module, a bounded context — drawn as a box around them.
const Layer = Schema.Struct({
  id: Schema.String,
  type: Schema.optionalKey(Schema.Literals(["tier", "enclosing"])),
  message: Schema.optionalKey(Schema.String),
});

export const Manifest = Schema.Struct({
  // How an import specifier becomes a file. Every pattern below is matched
  // against a resolved path, so this is what makes the rest of the file mean
  // anything.
  resolve: ResolveConfig,
  baseline: Schema.optionalKey(Schema.String),
  // Prohibitions that hold everywhere, declared once. `not-to-spec` and the
  // "this driver lives in one package" rules are statements about the whole
  // repo, not about a tier — putting them on every tree root would be six
  // copies and a seventh forgotten.
  deny: Schema.optionalKey(Schema.Array(Denial)),
  exports: Schema.optionalKey(Schema.Array(ExportRestriction)),
  graph: Schema.optionalKey(Graph),
  limits: Schema.optionalKey(Limits),
  // Shorthands expanded in every glob, so a pattern reads the way the repo's own
  // imports do rather than repeating `packages/server/src` on every line.
  aliases: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  // The layers the tree's nodes may name, outermost first. Optional: a tree
  // that names layers without declaring them gets them in the order they
  // are first met, all of type `tier`.
  layers: Schema.optionalKey(Schema.Array(Layer)),
  tree: Schema.Record(Schema.String, ManifestNodeSchema),
});

export type Manifest = typeof Manifest.Type;
export type LayerSpec = typeof Layer.Type;
export type ImportsSpec = typeof Imports.Type;
export type ImportedBySpec = typeof ImportedBy.Type;
export type MembersSpec = typeof Members.Type;
export type SurfaceSpec = typeof Surface.Type;
export type GraphSpec = typeof Graph.Type;
export type LimitsSpec = typeof Limits.Type;
export type NamingSpec = typeof Naming.Type;
export type ExportRestriction = typeof ExportRestriction.Type;

export const globsOf = (globs: string | ReadonlyArray<string>): ReadonlyArray<string> =>
  typeof globs === "string" ? [globs] : globs;

// Every issue, not the first: a manifest is edited by hand, and the reader
// fixing one line wants to know about the other three. A key the schema does
// not declare is refused rather than dropped — a misspelled `matchNot` that
// decoded to nothing would be a rule quietly enforcing less than it says.
const decode = Schema.decodeUnknownResult(Manifest, { errors: "all", onExcessProperty: "error" });
const flatten = SchemaIssue.makeFormatterStandardSchemaV1();

export type DecodedManifest = {
  readonly manifest: Manifest;
  // Things the manifest said in a form that still loads but is on its way out.
  // The host prints them; nothing else acts on them.
  readonly notices: ReadonlyArray<string>;
  // Every `use` the expansion replaced. Lowering reads them to say which
  // fragment an allowance came through; nothing else needs them.
  readonly substitutions: ReadonlyArray<Substitution>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isList = (value: unknown): value is ReadonlyArray<unknown> => Array.isArray(value);

// The three resolver options that used to sit on `resolve` itself, when every
// scope was a TypeScript scope and there was nowhere else to put them.
const LEGACY_RESOLVER_OPTIONS = ["extensions", "conditionNames", "mainFields"] as const;

// Until this beta ends, a scope written as `{ files, tsconfig }` is read as a
// TypeScript scope with `options: { tsconfig }`, and resolver options on
// `resolve` itself are folded into every TypeScript scope. Rewritten here, on
// the raw input, so the schema itself never has to know the old shape.
const normalizeLegacyResolve = (
  input: unknown,
): { readonly input: unknown; readonly notices: ReadonlyArray<string> } => {
  if (!isRecord(input) || !isRecord(input.resolve) || !isList(input.resolve.scopes)) {
    return { input, notices: [] };
  }
  const resolve = input.resolve;
  const rawScopes = input.resolve.scopes;
  const notices: Array<string> = [];

  const hoisted = Object.fromEntries(
    LEGACY_RESOLVER_OPTIONS.flatMap((key) => (key in resolve ? [[key, resolve[key]]] : [])),
  );
  if (Object.keys(hoisted).length > 0) {
    notices.push(
      `resolve.${Object.keys(hoisted).join(", resolve.")} on \`resolve\` itself is deprecated: ` +
        `these are TypeScript resolver options, and belong in a TypeScript scope's \`options\`.`,
    );
  }

  const scopes = rawScopes.map((scope, index) => {
    if (!isRecord(scope)) return scope;
    const { tsconfig, ...rest } = scope;
    if (tsconfig === undefined || "language" in scope) {
      return scope.language === "typescript" &&
        Object.keys(hoisted).length > 0 &&
        isRecord(scope.options)
        ? { ...scope, options: { ...hoisted, ...scope.options } }
        : scope;
    }
    notices.push(
      `resolve.scopes[${String(index)}] names a \`tsconfig\` with no \`language\`. That shape is ` +
        `deprecated: write { files, language: "typescript", options: { tsconfig } }.`,
    );
    return { ...rest, language: "typescript", options: { ...hoisted, tsconfig } };
  });

  const { conditionNames: _c, extensions: _e, mainFields: _m, ...restOfResolve } = resolve;
  return { input: { ...input, resolve: { ...restOfResolve, scopes } }, notices };
};

// Until this beta ends, `subject: "type-members"` reads as `subject: "members"`
// with `declares: ["type", "interface"]` — the TypeScript split between types
// and values, which the vocabulary no longer carries. Rewritten on the raw
// tree, so the schema itself never has to know the old name.
const normalizeLegacyMembers = (
  input: unknown,
): { readonly input: unknown; readonly notices: ReadonlyArray<string> } => {
  if (!isRecord(input) || !isRecord(input.tree)) return { input, notices: [] };
  const notices: Array<string> = [];

  const node = (key: string, value: unknown): unknown => {
    if (!isRecord(value)) return value;
    const members = isList(value.members)
      ? value.members.map((spec) => {
          if (!isRecord(spec) || spec.subject !== "type-members") return spec;
          notices.push(
            `"${key}" has a members rule with \`subject: "type-members"\`. That name is ` +
              `deprecated: write \`subject: "members", declares: ["type", "interface"]\`.`,
          );
          return { ...spec, subject: "members", declares: spec.declares ?? ["type", "interface"] };
        })
      : value.members;
    const children = isRecord(value.children)
      ? Object.fromEntries(
          Object.entries(value.children).map(([childKey, child]) => [
            childKey,
            node(childKey, child),
          ]),
        )
      : value.children;
    return {
      ...value,
      ...(members === undefined ? {} : { members }),
      ...(children === undefined ? {} : { children }),
    };
  };

  const tree = Object.fromEntries(
    Object.entries(input.tree).map(([key, value]) => [key, node(key, value)]),
  );
  return { input: { ...input, tree }, notices };
};

export type DecodeManifestOptions = {
  // Turns a path in the file into a line and column. The YAML reader supplies
  // one; a JavaScript module has no positions to give and passes nothing.
  readonly locate?: ManifestLocator | undefined;
};

const fileLabelOf = (configPath: string): string => configPath.split(/[\\/]/).at(-1) ?? configPath;

// A position carries its own file when the value was written in a file the
// manifest `include`d; otherwise it is in the manifest file itself.
const positionOf = (
  file: string,
  locate: ManifestLocator | undefined,
  path: ManifestPath,
): string | null => {
  const found = locate?.(path) ?? null;
  return found === null
    ? null
    : `${found.file ?? file}:${String(found.line)}:${String(found.column)}`;
};

// One line per issue: where in the file, which path, what was wrong — and,
// when the value came in through a `use`, the reference that pulled it in,
// since the fragment's own line may sit far from where the reader is looking.
const describeIssue = (
  configPath: string,
  locate: ManifestLocator | undefined,
  substitutions: ReadonlyArray<Substitution>,
  path: ManifestPath,
  detail: string,
): string => {
  const file = fileLabelOf(configPath);
  const origin = originOf(substitutions, path);
  const at = positionOf(file, locate, origin.path);
  const via = origin.via.map(({ at: ref, name }) => {
    const position = positionOf(file, locate, ref);
    return `via \`use: ${JSON.stringify(name)}\`${position === null ? "" : ` at ${position}`}`;
  });
  return (
    `  ${at === null ? "" : `${at}  `}${renderManifestPath(origin.path)}: ${detail}` +
    (via.length === 0 ? "" : ` (${via.join(", ")})`)
  );
};

// The standard-schema formatter flattens the issue tree to `{ path, message }`
// pairs; a path segment may arrive wrapped as `{ key }`.
const pathOf = (issue: {
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}): ManifestPath =>
  (issue.path ?? []).map((segment) => (typeof segment === "object" ? segment.key : segment));

export const decodeManifest = (
  configPath: string,
  input: unknown,
  options: DecodeManifestOptions = {},
): Result.Result<DecodedManifest, ConfigInvalid> => {
  const expanded = expandManifest(input);
  if (Result.isFailure(expanded)) {
    return Result.fail(
      new ConfigInvalid({
        configPath,
        detail:
          "the manifest does not expand:\n" +
          describeIssue(
            configPath,
            options.locate,
            [],
            expanded.failure.path,
            expanded.failure.detail,
          ),
      }),
    );
  }
  const { substitutions, value } = expanded.success;

  const resolve = normalizeLegacyResolve(value);
  const members = normalizeLegacyMembers(resolve.input);
  const decoded = decode(members.input);
  if (Result.isFailure(decoded)) {
    const lines = flatten(decoded.failure.issue).issues.map((issue) =>
      describeIssue(configPath, options.locate, substitutions, pathOf(issue), issue.message),
    );
    return Result.fail(
      new ConfigInvalid({
        configPath,
        detail: `the manifest does not decode:\n${lines.join("\n")}`,
      }),
    );
  }
  return Result.succeed({
    manifest: decoded.success,
    notices: [...resolve.notices, ...members.notices],
    substitutions,
  });
};
