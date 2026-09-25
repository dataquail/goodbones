import {
  BindingKind,
  DeclarationKind,
  ImportProbeTarget,
  MemberSubject,
  PatternList,
} from "@goodbones/core";
import * as Schema from "effect/Schema";

// The lowered vocabulary of the campaigns family — what the manifest's
// `campaigns` map becomes once its globs are resolved, and what the
// evaluators in `core/` compile. It reaches into @goodbones/core only for
// the pattern primitives the other families already speak: an import's
// probe target, a binding kind, a declaration kind, a member subject.

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
  // A scalar objective's probe only: the number the file contributes. A
  // `fires` probe without one asserts only that it is above zero.
  value: Schema.optionalKey(Schema.Finite),
});

export const CampaignProbes = Schema.Struct({
  fires: Schema.Array(CampaignProbe),
  ignores: Schema.Array(CampaignProbe),
});

// Where a scalar objective's number comes from, per file: its non-blank
// lines, the file itself (so a sector's value is its file count), the
// diagnostics a report puts on it, or what a `module#export` function
// answers for it. A sector's value is the sum over its files.
export const MeasureSource = Schema.Union([
  Schema.Struct({ lines: Schema.Literal(true) }),
  Schema.Struct({ files: Schema.Literal(true) }),
  Schema.Struct({ report: ReportTerm }),
  Schema.Struct({ fn: Schema.String }),
]);
export type MeasureSource = (typeof MeasureSource)["Type"];

// A scalar objective's number: one source summed, a ratio of two sums
// (`scale × Σof / Σper`, 0 where `per` sums to 0), or — for a campaign with
// no perimeter, whose scope is its one sector — a command whose output is
// the number, read whole or through a `pattern` with a `value` group.
export const Measure = Schema.Union([
  MeasureSource,
  Schema.Struct({
    ratio: Schema.Struct({ of: MeasureSource, per: MeasureSource, scale: Schema.Finite }),
  }),
  Schema.Struct({ command: Schema.String, pattern: Schema.optionalKey(Schema.String) }),
]);
export type Measure = (typeof Measure)["Type"];

// Which way a scalar objective's number is better.
export const MeasureDirection = Schema.Literals(["down", "up"]);
export type MeasureDirection = (typeof MeasureDirection)["Type"];

// An objective: a detector, a granularity, probes, and a ledger that only
// shrinks on its own. Owned by one campaign; named by at most one phase (an
// objective no phase names is in window in every phase). Exactly one of
// `match` (a per-file detector, evaluated by both hosts), `sector` (a term
// over the sector's files, evaluated by the CLI) and `measure` (a number
// per sector, evaluated by the CLI and read off its ledger by the plugin) —
// or, for the objectives an `endState` expands into, `endState` naming the
// family.
export const ObjectiveRule = Schema.Struct({
  // `campaign/<campaign>/<objective>`, the rule name a violation carries.
  name: Schema.String,
  id: Schema.String,
  campaign: Schema.String,
  // The `how`: what a reader at a holdout does about it.
  message: Schema.String,
  why: Schema.optionalKey(Schema.String),
  // Absent for a scalar objective, which holds nothing out.
  holdout: Schema.optionalKey(Holdout),
  match: Schema.optionalKey(Detector),
  sector: Schema.optionalKey(SectorTerm),
  // A scalar objective: a number per sector with a direction, held to the
  // value its ledger last recorded within `tolerance`, and met — for the
  // phase that names it — at `target`.
  measure: Schema.optionalKey(Measure),
  direction: Schema.optionalKey(MeasureDirection),
  tolerance: Schema.optionalKey(Schema.Finite),
  target: Schema.optionalKey(Schema.Finite),
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
