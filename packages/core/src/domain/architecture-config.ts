import * as Schema from "effect/Schema";

// Every pattern in this config is a JavaScript regular-expression source string
// matched against a repo-relative, forward-slash path — the same vocabulary
// dependency-cruiser rules are written in, so a rule ported from there keeps its
// pattern character-for-character. A list matches when ANY member matches.
const PatternList = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

// An import edge is a violation when the importer matches `from` (and not
// `fromNot`) AND the resolved target matches `to` (and not `toNot`). Omitting
// `to` means "any target", which is how a rule expresses "this folder may not
// import anything outside its allowlist" as a single `toNot`.
// A synthetic edge this rule must report. Every rule carries one: a configured
// rule that reports nothing is indistinguishable from a clean codebase, and that
// is the failure this package exists to make impossible. `from` is a repo-relative
// importer path. `to` is the target in one of three forms, and the form is its
// dependency kind: a repo-relative resolved path is `local`, `{ external }`
// names a third-party package, `{ builtin }` names a runtime module.
export const ImportProbeTarget = Schema.Union([
  Schema.String,
  Schema.Struct({ external: Schema.String }),
  Schema.Struct({ builtin: Schema.String }),
]);

const ImportProbe = Schema.Struct({
  from: Schema.String,
  to: ImportProbeTarget,
});

// One entry of an `imports` allowlist, as the author wrote it and where. An
// allowlist rule compiles its entries into `toNot` patterns and `externals`
// names, which is all evaluation needs; this is the other direction — from a
// pattern back to the line in the manifest that put it there — so a report
// can say which line no import uses. Slack is the signature of an allowlist
// widened to make a build green, and it is only visible with the entry kept.
export const Allowance = Schema.Struct({
  // The manifest node that declared the entry, as rule names name nodes.
  node: Schema.String,
  // `allow` is a path glob; `external` is a package name.
  kind: Schema.Literals(["allow", "external"]),
  // The entry as written, after alias expansion.
  entry: Schema.String,
  // For an `allow`: the compiled target pattern, as `toNot` carries it.
  pattern: Schema.optionalKey(Schema.String),
  // The `defs` fragment the entry arrived through, when the node wrote
  // `use: <name>` rather than the entry itself. Slack is attributed to the
  // fragment then: the node's authors wrote one word, and the line to delete
  // is in `defs`.
  fragment: Schema.optionalKey(Schema.String),
});

export const ImportRule = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  probe: ImportProbe,
  from: PatternList,
  fromNot: Schema.optionalKey(PatternList),
  to: Schema.optionalKey(PatternList),
  toNot: Schema.optionalKey(PatternList),
  // Where each `toNot` pattern and `externals` name came from, for an
  // allowlist lowered from a manifest. A hand-written rule carries none.
  allowances: Schema.optionalKey(Schema.Array(Allowance)),
  // Third-party packages this rule permits, by package name. An external
  // target is judged by its package, never by where the language's resolver
  // happened to find it on disk — `to`/`toNot` patterns are for the
  // repository's own files.
  externals: Schema.optionalKey(Schema.Array(Schema.String)),
  // `external` is a third-party package, `builtin` a runtime module, `local`
  // anything in the repository. Compared against what the resolver reports,
  // never read off a path. Replaces dependency-cruiser's `dependencyTypes`,
  // whose finer npm grades no rule in this repo distinguishes.
  dependencyKind: Schema.optionalKey(Schema.Literals(["external", "local", "builtin"])),
});

// Which language pack resolves and parses the files a scope covers. A monorepo
// needs several scopes even in one language — the web pass resolves `@/*` the
// server pass does not — and a second language is one more scope. `options`
// belong to the language: the policy carries them opaquely and the pack
// validates them at load, so nothing here knows what a tsconfig is.
const ResolveScope = Schema.Struct({
  // A regular-expression source matched against the importing file's path.
  files: Schema.String,
  language: Schema.String,
  options: Schema.optionalKey(Schema.Unknown),
});

export const ResolveConfig = Schema.Struct({
  scopes: Schema.Array(ResolveScope),
  // An edge nobody can resolve is an edge no rule can police, which is the
  // silent-vacuity failure this whole package exists to prevent. Default loud.
  unresolved: Schema.optionalKey(Schema.Literals(["error", "off"])),
  ignoreUnresolved: Schema.optionalKey(Schema.Array(Schema.String)),
});

// The autofix strategies a rule may name. Each is a rewrite in one language's
// module syntax, so a language pack lists the ones it implements.
export const ExportFix = Schema.Literals(["subpath-namespace-import"]);

// Which binding form an import site used. A rule that fences off a factory
// function cares about `named`; one steering people to namespace subpath imports
// cares that `named` was used at all.
const BindingKind = Schema.Literals(["named", "default", "namespace"]);

// `source`, when present, is a snippet the loading adapter parses: the probe
// then holds only if a binding named `symbol` comes out of the parser and the
// rule covers it, with every edge in the snippet taken to resolve to `to`.
// Without it the probe is a synthetic binding of `symbol` and `kind`.
const ExportProbe = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  symbol: Schema.String,
  kind: Schema.optionalKey(BindingKind),
  source: Schema.optionalKey(Schema.String),
});

// Where a given *exported symbol* may be imported. `imports` asks whether one
// file may reach another at all; this asks which names it may pull across when
// it does — the distinction a path rule cannot make, because every importer of a
// barrel resolves to the same file.
export const ExportRule = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  probe: ExportProbe,
  from: PatternList,
  fromNot: Schema.optionalKey(PatternList),
  to: PatternList,
  toNot: Schema.optionalKey(PatternList),
  // Exact exported names. Omit to mean "any name", which is how a rule bans a
  // whole binding form (every named import from a package barrel, say).
  symbols: Schema.optionalKey(Schema.Array(Schema.String)),
  // Defaults to ["named"] — the discriminating form for every rule of this shape
  // written so far.
  kinds: Schema.optionalKey(Schema.Array(BindingKind)),
  // A named autofix strategy, which a language pack may or may not implement:
  // the loader refuses a rule naming one no loaded language does.
  // `subpath-namespace-import` is an ES-module rewrite — `import { A, B as C }
  // from "pkg"` into `import * as A from "pkg/A"` / `import * as C from "pkg/B"`,
  // for packages that publish each module as its own subpath. A rule carrying a
  // fix reports once per declaration rather than once per symbol, because the
  // fix rewrites the whole declaration.
  fix: Schema.optionalKey(ExportFix),
});

// What a name was declared as. For an export site, the declaration that
// introduced it; for a member site, the declaration it is written in.
// `expression` is `export default <expr>`; `other` covers a namespace, an
// `export =`, and a re-export, whose declaration is somewhere else. A second
// language will want `struct`, `record`, `constant`, `module` here; they are
// added with the pack that reads them, not before.
export const DeclarationKind = Schema.Literals([
  "function",
  "class",
  "variable",
  "type",
  "interface",
  "enum",
  "expression",
  "other",
]);

// What kind of name a rule is about. `members` are the names written in a
// named declaration — a type alias, an interface, a class body — under that
// declaration's name (a port's method vocabulary); `calls` are called
// identifiers (the hooks a tier may reach for). Which declarations a `members`
// rule speaks to is `declares`' to say, so the vocabulary carries no language's
// split between types and values.
const MemberSubject = Schema.Literals(["members", "calls"]);

// `source`, when present, is a snippet the loading adapter parses: the probe
// then holds only if a site named `name` comes out of the parser and the rule
// reports it — the declaration shape is the parser's to judge, not `in`'s.
// Without it the probe is a synthetic site of `name` inside `in`, declared as
// `declares`.
const MemberProbe = Schema.Struct({
  from: Schema.String,
  name: Schema.String,
  in: Schema.optionalKey(Schema.String),
  declares: Schema.optionalKey(DeclarationKind),
  source: Schema.optionalKey(Schema.String),
});

// Which names a file is allowed to declare or call. This is the one family that
// needs no module resolution: it is about the vocabulary inside a file, not the
// edges leaving it.
export const MemberRule = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  probe: MemberProbe,
  from: PatternList,
  fromNot: Schema.optionalKey(PatternList),
  subject: MemberSubject,
  // `members` only: which declaration's members are governed, by its name.
  in: Schema.optionalKey(PatternList),
  // `members` only: which kinds of declaration are governed. Omit for every
  // kind — a type alias, an interface and a class body alike.
  declares: Schema.optionalKey(Schema.Array(DeclarationKind)),
  // Which names the rule speaks to at all. Omit for "every one".
  match: Schema.optionalKey(PatternList),
  matchNot: Schema.optionalKey(PatternList),
  // Names that are fine. A name the rule speaks to and this does not admit is
  // the violation.
  allow: Schema.optionalKey(PatternList),
});

// One export site, as a probe states it: the name (`default` for a default
// export, `*` for `export *`), its binding kind, and optionally what it was
// declared as and whether it is a re-export.
const SurfaceSite = Schema.Struct({
  name: Schema.String,
  kind: BindingKind,
  declares: Schema.optionalKey(DeclarationKind),
  reexport: Schema.optionalKey(Schema.Boolean),
});

// A whole surface, because `count` is about the file rather than a site.
// `source`, when present, is parsed by the loading adapter instead.
const SurfaceProbe = Schema.Struct({
  from: Schema.String,
  sites: Schema.optionalKey(Schema.Array(SurfaceSite)),
  source: Schema.optionalKey(Schema.String),
});

// What a file may export. The selectors (`kinds`, `declares`, `reexport`,
// `match`) say which sites the rule speaks to; exactly one demand says what is
// required of them. No demand means `forbid`: a selected site is the violation.
export const SurfaceRule = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  probe: SurfaceProbe,
  from: PatternList,
  fromNot: Schema.optionalKey(PatternList),
  kinds: Schema.optionalKey(Schema.Array(BindingKind)),
  declares: Schema.optionalKey(Schema.Array(DeclarationKind)),
  reexport: Schema.optionalKey(Schema.Boolean),
  match: Schema.optionalKey(PatternList),
  matchNot: Schema.optionalKey(PatternList),
  forbid: Schema.optionalKey(Schema.Boolean),
  // Names that are fine; a selected site named otherwise is the violation.
  allow: Schema.optionalKey(PatternList),
  // A regular-expression source every selected name must match.
  convention: Schema.optionalKey(Schema.String),
  // How many selected sites the file may have.
  count: Schema.optionalKey(
    Schema.Struct({
      min: Schema.optionalKey(Schema.Finite),
      max: Schema.optionalKey(Schema.Finite),
    }),
  ),
});

// A small synthetic graph the rule must report on: the edges, and any files
// that take part without an edge (an orphan has none).
const GraphProbe = Schema.Struct({
  edges: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  files: Schema.optionalKey(Schema.Array(Schema.String)),
});

// Rules about the shape of the whole import graph, which no single file can
// answer. The CLI evaluates them; the plugin, which sees one file at a time,
// compiles and probes them so a vacuous one still fails to load.
export const GraphCycleRule = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  probe: GraphProbe,
  within: PatternList,
  withinNot: Schema.optionalKey(PatternList),
});

export const GraphOrphanRule = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  probe: GraphProbe,
  within: PatternList,
  withinNot: Schema.optionalKey(PatternList),
  // Files that are imported by nothing by design — the program's entry points.
  entry: PatternList,
});

export const GraphReachRule = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  probe: GraphProbe,
  from: PatternList,
  fromNot: Schema.optionalKey(PatternList),
  to: PatternList,
  toNot: Schema.optionalKey(PatternList),
  // The tier that was supposed to mediate: a path stepping onto a `via` file is
  // allowed, so only a path that avoids every `via` is the violation.
  via: Schema.optionalKey(PatternList),
});

export const GraphConfig = Schema.Struct({
  cycles: Schema.optionalKey(Schema.Array(GraphCycleRule)),
  orphans: Schema.optionalKey(Schema.Array(GraphOrphanRule)),
  reach: Schema.optionalKey(Schema.Array(GraphReachRule)),
});

// A campaign: one multi-step refactor, tracked as an object in the
// repository. Where a rule says what may never happen, a campaign names what
// the code is moving away from — as `objectives`, each a detector with a
// ledger that only shrinks on its own — over `sectors` the code declares
// through a `perimeter`, through an ordered sequence of `phases` toward an
// end. Lowered from the manifest's `campaigns` map with its globs resolved;
// the detector below is what the evaluator compiles.

// What one holdout is: a whole file, a named declaration in it, one matched
// expression, or the sector itself (for a presence objective — the sector is
// the holdout while nothing in it matches). The first three are the unit a
// per-file detector answers at; the unit decides what a term from another
// level means (a file-level term in a declaration objective is a filter; a
// declaration-level term in a file objective is existential) and what the
// fingerprint anchors on.
export const CampaignUnit = Schema.Literals(["file", "declaration", "match"]);
export const Holdout = Schema.Literals(["file", "declaration", "match", "sector"]);

// The detector's leaf terms. Every pattern is a regular-expression source,
// as everywhere else in this config; the manifest writes globs and lowering
// translates them. Each term answers at one level — `path`, `imports`,
// `requires`, `content` and a boolean `fn` about the file; `exports` and
// `members` about a declaration; `syntax` and a listing `fn` about a match.
const PathTerm = Schema.Struct({
  file: PatternList,
  fileNot: Schema.optionalKey(PatternList),
  // With `convention`: which capture group of `file` holds the name being
  // judged, and the shape it must have for the term to hold.
  subject: Schema.optionalKey(Schema.Finite),
  convention: Schema.optionalKey(Schema.String),
});
export type PathTerm = (typeof PathTerm)["Type"];

const ImportsTerm = Schema.Struct({
  // Where an edge of the file must resolve to: a path pattern, a package
  // name, or a builtin. Holds when at least one edge does.
  resolves: ImportProbeTarget,
  // Names that must be pulled across that edge; omit for any binding.
  symbols: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ImportsTerm = (typeof ImportsTerm)["Type"];

const ExportsTerm = Schema.Struct({
  name: Schema.optionalKey(PatternList),
  kinds: Schema.optionalKey(Schema.Array(BindingKind)),
  declares: Schema.optionalKey(Schema.Array(DeclarationKind)),
  reexport: Schema.optionalKey(Schema.Boolean),
});
export type ExportsTerm = (typeof ExportsTerm)["Type"];

const MembersTerm = Schema.Struct({
  subject: MemberSubject,
  name: Schema.optionalKey(PatternList),
  in: Schema.optionalKey(PatternList),
  declares: Schema.optionalKey(Schema.Array(DeclarationKind)),
});
export type MembersTerm = (typeof MembersTerm)["Type"];

const ContentTerm = Schema.Struct({ regex: Schema.String });
type ContentTerm = (typeof ContentTerm)["Type"];

// How a metavariable of a syntax rule is narrowed: by the text it captured,
// or by what the identifier at its root is bound to — the module it was
// imported from and the name it was imported as.
const BindingNarrowing = Schema.Struct({
  resolves: ImportProbeTarget,
  member: Schema.optionalKey(Schema.Array(Schema.String)),
});

const CaptureNarrowing = Schema.Struct({
  regex: Schema.optionalKey(Schema.String),
  binding: Schema.optionalKey(BindingNarrowing),
});

const SyntaxTerm = Schema.Struct({
  // The engine's rule object, carried opaquely: the matcher validates it.
  rule: Schema.Unknown,
  where: Schema.optionalKey(Schema.Record(Schema.String, CaptureNarrowing)),
});
export type SyntaxTerm = (typeof SyntaxTerm)["Type"];

// A pattern no parser of ours sees, reported by another program: a type
// error, another linter's finding. Exactly one of `command` (run from the
// repository root, once per process) and `file` (written by an earlier
// step), each a list — the manifest's one string lowered to a list of one —
// read as one report. Each diagnostic on a file is a match anchored on the
// declaration at its position, keyed by its code and a hash of its message.
export const ReportFormat = Schema.Literals(["tsc", "eslint", "oxlint", "regex"]);

const ReportTerm = Schema.Struct({
  command: Schema.optionalKey(Schema.Array(Schema.String)),
  file: Schema.optionalKey(Schema.Array(Schema.String)),
  format: ReportFormat,
  // `regex` only: named groups `file`, `line`, and optionally `column`,
  // `code`, `message`.
  pattern: Schema.optionalKey(Schema.String),
  // The codes the term speaks to; omit for every one.
  codes: Schema.optionalKey(Schema.Array(Schema.String)),
  codesNot: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ReportTerm = (typeof ReportTerm)["Type"];

export type Detector =
  | { readonly all: ReadonlyArray<Detector> }
  | { readonly any: ReadonlyArray<Detector> }
  | { readonly not: Detector }
  | { readonly path: PathTerm }
  | { readonly imports: ImportsTerm }
  | { readonly exports: ExportsTerm }
  | { readonly members: MembersTerm }
  | { readonly requires: ReadonlyArray<string> }
  | { readonly content: ContentTerm }
  | { readonly syntax: SyntaxTerm }
  | { readonly report: ReportTerm }
  // `module#export`, resolved by the host before the policy loads.
  | { readonly fn: string };

const DetectorRef = Schema.suspend((): Schema.Codec<Detector> => Detector);

export const Detector = Schema.Union([
  Schema.Struct({ all: Schema.Array(DetectorRef) }),
  Schema.Struct({ any: Schema.Array(DetectorRef) }),
  Schema.Struct({ not: DetectorRef }),
  Schema.Struct({ path: PathTerm }),
  Schema.Struct({ imports: ImportsTerm }),
  Schema.Struct({ exports: ExportsTerm }),
  Schema.Struct({ members: MembersTerm }),
  Schema.Struct({ requires: Schema.Array(Schema.String) }),
  Schema.Struct({ content: ContentTerm }),
  Schema.Struct({ syntax: SyntaxTerm }),
  Schema.Struct({ report: ReportTerm }),
  Schema.Struct({ fn: Schema.String }),
]);

// A term quantified over the sector's files rather than answered by one.
// `has` takes an ordinary detector and holds when at least one file (or
// declaration, or match) in the sector satisfies it — a presence, whose
// holdout is the sector until something matches. `oneRoot` holds when every
// file of the sector sits under the root its perimeter was found at, which
// is what an `endState` needs; `oneHost` when every file matches the host.
// Each needs the sector's file list and nothing else, so the CLI reports
// them and the plugin, which sees one file, reads only their effect on the
// sector's phase through the ledger.
export const SectorTerm = Schema.Union([
  Schema.Struct({ has: Detector }),
  Schema.Struct({ oneRoot: Schema.Literal(true) }),
  Schema.Struct({ oneHost: PatternList }),
]);
export type SectorTerm = (typeof SectorTerm)["Type"];

// One diagnostic a probe stands in for, positions one-based as a tool
// prints them.
export const ProbeDiagnostic = Schema.Struct({
  line: Schema.Finite,
  column: Schema.optionalKey(Schema.Finite),
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});

// A source an objective is proven against: the path it would have, its text
// when a term needs one, the target of each of its edges (in place of the live
// resolver), the files beside it (in place of the file system) and the
// diagnostics reported on it (in place of the report source).
export const CampaignProbe = Schema.Struct({
  path: Schema.String,
  source: Schema.optionalKey(Schema.String),
  edges: Schema.optionalKey(Schema.Record(Schema.String, ImportProbeTarget)),
  files: Schema.optionalKey(Schema.Array(Schema.String)),
  report: Schema.optionalKey(Schema.Array(ProbeDiagnostic)),
});

export const CampaignProbes = Schema.Struct({
  fires: Schema.Array(CampaignProbe),
  ignores: Schema.Array(CampaignProbe),
});

// An objective: a detector, a granularity, probes, and a ledger that only
// shrinks on its own. Owned by one campaign; named by at most one phase (an
// objective no phase names is in window in every phase). Exactly one of
// `match` (a per-file detector, evaluated by both hosts) and `sector` (a
// term over the sector's files, evaluated by the CLI) — or, for the
// objectives an `endState` expands into, `endState` naming the family.
export const ObjectiveRule = Schema.Struct({
  // `campaign/<campaign>/<objective>`, the rule name a violation carries.
  name: Schema.String,
  id: Schema.String,
  campaign: Schema.String,
  // The `how`: what a reader at a holdout does about it.
  message: Schema.String,
  why: Schema.optionalKey(Schema.String),
  holdout: Holdout,
  match: Schema.optionalKey(Detector),
  sector: Schema.optionalKey(SectorTerm),
  endState: Schema.optionalKey(
    Schema.Struct({
      phase: Schema.String,
      family: Schema.Literals(["imports", "exports", "members", "surface", "structure"]),
    }),
  ),
  // The phase at which the objective stops counting, exclusive; absent, it
  // counts to the end.
  until: Schema.optionalKey(Schema.String),
  probes: CampaignProbes,
});

// How a sector is recognized. The name is the sector's identity. A `marker`
// is a file that names the sector (and may list the globs it owns); `glob`
// is one sector per match; `match` one sector per detector match, keyed by
// its anchor; `file` one sector per file, keyed by the path without its
// extension; `nx` reads the workspace's projects. A campaign with none has
// one implicit sector, the scope.
export const PerimeterRule = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("file") }),
  Schema.Struct({ kind: Schema.Literal("nx") }),
  Schema.Struct({ kind: Schema.Literal("glob"), glob: PatternList }),
  Schema.Struct({
    kind: Schema.Literal("marker"),
    marker: PatternList,
    probes: Schema.optionalKey(Schema.Struct({ fires: PatternList, ignores: PatternList })),
  }),
  Schema.Struct({
    kind: Schema.Literal("match"),
    match: Detector,
    unit: Schema.Literals(["declaration", "match"]),
    probes: CampaignProbes,
  }),
]);
export type PerimeterRule = (typeof PerimeterRule)["Type"];

// What a touched sector owes beyond the nudge. A strict ladder: the ledger
// records growth with a reason under `advise`; `ratchet` refuses it in a
// touched sector; `paydown` adds that a diff editing a holdout-bearing
// declaration must leave the sector with fewer holdouts.
export const OnTouch = Schema.Literals(["advise", "ratchet", "paydown"]);
export type OnTouch = (typeof OnTouch)["Type"];

// A dated receipt for a change to a defined phase, which authorizes the next
// `clear` to re-baseline the sectors in that phase's window.
export const PhaseConcession = Schema.Struct({
  reason: Schema.String,
  at: Schema.String,
  by: Schema.optionalKey(Schema.String),
});

// A phase: a named, ordered group of objectives. Defined when it names one
// (or is attested, or carries an end state); open when it has only an
// intent, and then it is last. `hash` is the phase's definition — its
// position, its objectives and their detectors — so a change to a defined
// phase is visible against the plan the ledger recorded.
export const PhaseRule = Schema.Struct({
  id: Schema.String,
  intent: Schema.optionalKey(Schema.String),
  objectives: Schema.Array(Schema.String),
  attested: Schema.Boolean,
  onTouch: Schema.optionalKey(OnTouch),
  // The sector-relative node tree, carried as written; expanded per sector
  // by the host that evaluates it.
  endState: Schema.optionalKey(Schema.Unknown),
  concessions: Schema.Array(PhaseConcession),
  hash: Schema.String,
});
export type PhaseRule = (typeof PhaseRule)["Type"];

export const CampaignRule = Schema.Struct({
  // `campaign/<id>`.
  name: Schema.String,
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  why: Schema.optionalKey(Schema.String),
  owner: Schema.optionalKey(Schema.String),
  scope: PatternList,
  // Extensions the campaign widens the walk to, beyond the packs' — a
  // JavaScript half a TypeScript pack does not visit.
  extensions: Schema.Array(Schema.String),
  // What the remainder of the scope counts as; absent, everything no sector
  // claims is legacy.
  legacy: Schema.optionalKey(PatternList),
  perimeter: Schema.optionalKey(PerimeterRule),
  onTouch: Schema.optionalKey(OnTouch),
  phases: Schema.Array(PhaseRule),
  objectives: Schema.Array(ObjectiveRule),
  // Milliseconds without progress after which the campaign is stalled;
  // absent, it never is.
  staleAfter: Schema.optionalKey(Schema.Finite),
  // What `check` demands once every count is zero: keep the campaign as a
  // guard against recurrence, or remove it from the manifest.
  onComplete: Schema.Literals(["keep", "remove"]),
});

const PathProbe = Schema.Struct({ path: Schema.String });

// The file taxonomy, as three questions rather than one nested tree.
//
// `roots` marks the regions where layout is deny-by-default. `folders` says
// which basenames each folder admits. `parity` says which siblings a file owes.
// Keeping them apart is what removes the nested config's most fragile rule —
// that a specific pattern must beat a `*` catch-all — because an exemption is
// now a `fileNot` on the parity rule that would otherwise fire.
const StructureRoot = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  probe: PathProbe,
  // A file under this path whose folder no `folders` rule governs is a file in a
  // folder the taxonomy does not know about.
  path: PatternList,
});

const StructureFolder = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  probe: PathProbe,
  // Matched against the file's folder, repo-relative, with no trailing slash.
  folder: PatternList,
  // Basenames this folder admits. Anything else is the violation.
  files: PatternList,
});

const StructureParity = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  probe: PathProbe,
  file: PatternList,
  fileNot: Schema.optionalKey(PatternList),
  // Paths that must exist, relative to the file's own folder. `{base}` is the
  // filename minus its final extension — `create-todo.handler` for
  // `create-todo.handler.ts`, `handler` for `handler.go` — so `{base}.test.ts`
  // or `{base}_test.go` names the sibling test in either language.
  requires: Schema.Array(Schema.String),
});

// What shape the variable part of a name may take. `folders` says which
// stereotypes a folder admits; this says what the concept name in front of the
// stereotype may look like — the degree of freedom a taxonomy alone leaves open.
const StructureNaming = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  probe: PathProbe,
  // Matched against the whole repo-relative path, and carrying capture groups:
  // `subject` says which of them holds the name being judged.
  file: PatternList,
  fileNot: Schema.optionalKey(PatternList),
  subject: Schema.Finite,
  // The shape the subject must have. Exactly one of these.
  convention: Schema.optionalKey(Schema.String),
  // A capture group the subject must equal, for "named after its folder".
  sameAs: Schema.optionalKey(Schema.Finite),
});

const StructureConfig = Schema.Struct({
  roots: Schema.optionalKey(Schema.Array(StructureRoot)),
  folders: Schema.optionalKey(Schema.Array(StructureFolder)),
  parity: Schema.optionalKey(Schema.Array(StructureParity)),
  naming: Schema.optionalKey(Schema.Array(StructureNaming)),
});

export type Allowance = (typeof Allowance)["Type"];
export type ImportRule = (typeof ImportRule)["Type"];
export type ResolveConfig = (typeof ResolveConfig)["Type"];
export type ResolveScope = (typeof ResolveScope)["Type"];
export type ImportProbe = (typeof ImportProbe)["Type"];
export type ImportProbeTarget = (typeof ImportProbeTarget)["Type"];
export type ExportRule = (typeof ExportRule)["Type"];
export type ExportProbe = (typeof ExportProbe)["Type"];
export type BindingKind = (typeof BindingKind)["Type"];
export type ExportFix = (typeof ExportFix)["Type"];
export type MemberRule = (typeof MemberRule)["Type"];
export type MemberProbe = (typeof MemberProbe)["Type"];
export type MemberSubject = (typeof MemberSubject)["Type"];
export type GraphProbe = (typeof GraphProbe)["Type"];
export type GraphCycleRule = (typeof GraphCycleRule)["Type"];
export type GraphOrphanRule = (typeof GraphOrphanRule)["Type"];
export type GraphReachRule = (typeof GraphReachRule)["Type"];
export type GraphConfig = (typeof GraphConfig)["Type"];
export type DeclarationKind = (typeof DeclarationKind)["Type"];
export type SurfaceRule = (typeof SurfaceRule)["Type"];
export type SurfaceProbe = (typeof SurfaceProbe)["Type"];
export type StructureConfig = (typeof StructureConfig)["Type"];
export type StructureRoot = (typeof StructureRoot)["Type"];
export type StructureFolder = (typeof StructureFolder)["Type"];
export type StructureParity = (typeof StructureParity)["Type"];
export type StructureNaming = (typeof StructureNaming)["Type"];
export type CampaignUnit = (typeof CampaignUnit)["Type"];
export type Holdout = (typeof Holdout)["Type"];
export type CampaignProbe = (typeof CampaignProbe)["Type"];
export type CampaignProbes = (typeof CampaignProbes)["Type"];
export type ProbeDiagnostic = (typeof ProbeDiagnostic)["Type"];
export type ReportFormat = (typeof ReportFormat)["Type"];
export type ObjectiveRule = (typeof ObjectiveRule)["Type"];
export type PhaseConcession = (typeof PhaseConcession)["Type"];
export type CampaignRule = (typeof CampaignRule)["Type"];
export type CaptureNarrowing = (typeof CaptureNarrowing)["Type"];

// The file pattern an open folder's layout rule carries: it admits any name,
// so it claims the folder without policing it. Coverage counts it apart.
export const OPEN_LAYOUT = "^.*$";

export const patternsOf = (patterns: string | ReadonlyArray<string>): ReadonlyArray<string> =>
  typeof patterns === "string" ? [patterns] : patterns;
