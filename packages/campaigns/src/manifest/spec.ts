import { DeclarationKind, ImportProbeTarget, SurfaceConvention } from "@goodbones/core";
import * as Schema from "effect/Schema";

import { Holdout, ProbeDiagnostic, ReportFormat } from "../domain/config.js";

// The authoring surface of the campaigns family: the `campaigns` map and the
// `ledger` path, as a reader writes them. @goodbones/core decodes everything
// else in the manifest and hands these two keys here, so the core codec never
// learns a word of this vocabulary. `lower.ts` turns what this decodes into
// the rules the evaluators compile.
//
// `Globs` is repeated here rather than imported: it is two lines, and a codec
// primitive shared across a package boundary would make every glob in the
// manifest a thing two packages have to agree about.

const Globs = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

// A campaign: a migration the repository is running, tracked as an object —
// a detector, a rationale, a guide, an owner, a definition of done, and a
// ledger of every place the pattern still occurs. Where a rule says what may
// never happen, a campaign names what the code is moving away from.
//
// The detector is a predicate algebra: `all`, `any` and `not` over leaf
// terms, the same three words ast-grep uses. Leaf terms reuse the other
// families' vocabularies where one exists.

// A regular expression over the whole repo-relative path, matched as the
// `structure` naming rules are: with `subject` and `convention`, the capture
// group named holds the name being judged, and the term holds when the name
// has the convention's shape.
const PathTerm = Schema.Struct({
  file: Globs,
  fileNot: Schema.optionalKey(Globs),
  subject: Schema.optionalKey(Schema.Finite),
  convention: Schema.optionalKey(SurfaceConvention),
});

// Holds when some import of the file resolves to the target — a path glob,
// `{ external: <package> }` or `{ builtin: <module> }` — and, with `symbols`,
// pulls one of those names across it.
const ImportsTerm = Schema.Struct({
  resolves: ImportProbeTarget,
  symbols: Schema.optionalKey(Schema.Array(Schema.String)),
});

// Holds for an export site the selectors admit — the `surface` selectors.
const ExportsTerm = Schema.Struct({
  name: Schema.optionalKey(Globs),
  kinds: Schema.optionalKey(Schema.Array(Schema.Literals(["named", "default", "namespace"]))),
  declares: Schema.optionalKey(Schema.Array(DeclarationKind)),
  reexport: Schema.optionalKey(Schema.Boolean),
});

// Holds for a member site the selectors admit — the `members` selectors.
const MembersTerm = Schema.Struct({
  subject: Schema.Literals(["members", "calls"]),
  name: Schema.optionalKey(Globs),
  in: Schema.optionalKey(Globs),
  declares: Schema.optionalKey(Schema.Array(DeclarationKind)),
});

// A regular expression over the file's text, multiline.
const ContentTerm = Schema.Struct({ regex: Schema.String });

// How a metavariable is narrowed: by the text it captured, or by what the
// identifier at its root is bound to — the module it resolves to and the
// name it was imported as (`member`), which is how `class $N extends $BASE`
// says "a React component" rather than "any class with a base".
const CaptureNarrowing = Schema.Struct({
  regex: Schema.optionalKey(Schema.String),
  binding: Schema.optionalKey(
    Schema.Struct({
      resolves: ImportProbeTarget,
      member: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});

// An ast-grep rule object — `pattern`, `kind`, `regex`, `has`, `inside`,
// `precedes`, `follows`, `nthChild`, `all`, `any`, `not` — with `where`
// beside it. The rule is the engine's to validate; the manifest only knows
// which keys are a rule's and which is the narrowing. `kind` names are the
// engine's node kinds, which today are tree-sitter's.
const SyntaxTerm = Schema.Struct({
  pattern: Schema.optionalKey(Schema.Unknown),
  kind: Schema.optionalKey(Schema.Unknown),
  regex: Schema.optionalKey(Schema.Unknown),
  nthChild: Schema.optionalKey(Schema.Unknown),
  inside: Schema.optionalKey(Schema.Unknown),
  has: Schema.optionalKey(Schema.Unknown),
  precedes: Schema.optionalKey(Schema.Unknown),
  follows: Schema.optionalKey(Schema.Unknown),
  all: Schema.optionalKey(Schema.Unknown),
  any: Schema.optionalKey(Schema.Unknown),
  not: Schema.optionalKey(Schema.Unknown),
  where: Schema.optionalKey(Schema.Record(Schema.String, CaptureNarrowing)),
});

// One program to run or file to read, or several: a tool that takes one
// project at a time is run once per project, and the outputs are read as
// one report — a diagnostic two of them print is one diagnostic.
const ReportSources = Schema.Union([
  Schema.String,
  Schema.Array(Schema.String).check(Schema.isMinLength(1)),
]);

// A finding of another program, read from the output of `command` (run
// from the repository root, once per `check`) or from `file` (written by
// an earlier step) in one of the known formats — `tsc`, `eslint --format
// json`, `oxlint --format json` — or by a `regex` with named groups. Holds
// for each diagnostic on the file whose code the term speaks to.
const ReportTerm = Schema.Struct({
  command: Schema.optionalKey(ReportSources),
  file: Schema.optionalKey(ReportSources),
  format: ReportFormat,
  pattern: Schema.optionalKey(Schema.String),
  codes: Schema.optionalKey(Schema.Array(Schema.String)),
  codesNot: Schema.optionalKey(Schema.Array(Schema.String)),
}).check(
  // Refused at decode, where the issue names a line, rather than in the
  // lowering: a term that names both sources or neither, and a `regex`
  // term with nothing to match lines against.
  Schema.makeFilter((term) => {
    const issues: Array<Schema.FilterIssue> = [];
    if ((term.command === undefined) === (term.file === undefined)) {
      issues.push(
        "a report term names exactly one of `command` (a program to run) and `file` (a report already written)",
      );
    }
    if (term.format === "regex" && term.pattern === undefined) {
      issues.push({
        path: ["pattern"],
        issue: "a `regex` report term needs a `pattern` with named groups `file` and `line`",
      });
    }
    return issues;
  }),
);

export type DetectorSpec =
  | { readonly all: ReadonlyArray<DetectorSpec> }
  | { readonly any: ReadonlyArray<DetectorSpec> }
  | { readonly not: DetectorSpec }
  | { readonly path: typeof PathTerm.Type }
  | { readonly imports: typeof ImportsTerm.Type }
  | { readonly exports: typeof ExportsTerm.Type }
  | { readonly members: typeof MembersTerm.Type }
  // The `structure` parity strings: holds when every named sibling exists.
  | { readonly requires: ReadonlyArray<string> }
  | { readonly content: typeof ContentTerm.Type }
  | { readonly syntax: typeof SyntaxTerm.Type }
  | { readonly report: typeof ReportTerm.Type }
  // `module#export`: a predicate function the host imports before loading.
  | { readonly fn: string };

// Each object carries exactly one term key, so a misspelled one is a decode
// error that names the line rather than a term quietly dropped.
const DetectorRef = Schema.suspend((): Schema.Codec<DetectorSpec> => DetectorSpec);

const DetectorSpec = Schema.Union([
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

// A source an objective is proven against at load. `path` alone proves a
// path-shaped detector; `source` is parsed, `edges` answers the `imports`
// term and a binding narrowing in place of the live resolver, `files`
// answers `requires` in place of the file system, and `report` answers a
// `report` term in place of running anything — one-based positions, as a
// tool prints them.
const CampaignProbe = Schema.Struct({
  path: Schema.String,
  source: Schema.optionalKey(Schema.String),
  edges: Schema.optionalKey(Schema.Record(Schema.String, ImportProbeTarget)),
  files: Schema.optionalKey(Schema.Array(Schema.String)),
  report: Schema.optionalKey(Schema.Array(ProbeDiagnostic)),
  // A scalar objective's probe: the number the file contributes.
  value: Schema.optionalKey(Schema.Finite),
});

const CampaignProbes = Schema.Struct({
  fires: Schema.Array(CampaignProbe),
  ignores: Schema.optionalKey(Schema.Array(CampaignProbe)),
});

// `30d`, `12h`: how long a campaign may go without progress before the
// conformance report calls it stalled.
const Duration = Schema.String.check(Schema.isPattern(/^\d+[dh]$/));

const KebabId = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));

// A term quantified over a sector's files: `has` a detector at least one
// file (or declaration, or match) in the sector satisfies — a presence;
// `oneRoot` every file under the root the perimeter was found at; `oneHost`
// every file under the host named.
const SectorTermSpec = Schema.Union([
  Schema.Struct({ has: DetectorRef }),
  Schema.Struct({ oneRoot: Schema.Literal(true) }),
  Schema.Struct({ oneHost: Globs }),
]);

// Where a scalar objective's number comes from, per file, summed over a
// sector: `lines` (non-blank), `files` (one each), the diagnostics a
// `report` puts on the file, or the number an `fn` returns for it.
const MeasureSourceSpec = Schema.Union([
  Schema.Struct({ lines: Schema.Literal(true) }),
  Schema.Struct({ files: Schema.Literal(true) }),
  Schema.Struct({ report: ReportTerm }),
  Schema.Struct({ fn: Schema.String }),
]);

// A scalar objective's number: one source, a `ratio` of two (`scale × Σof /
// Σper`, `scale` defaulting to 1), or a `command` whose output is the number
// — whole, or the `value` group of `pattern`. A command measures the
// repository, not a file, so only a campaign with no perimeter may run one.
const MeasureSpec = Schema.Union([
  MeasureSourceSpec,
  Schema.Struct({
    ratio: Schema.Struct({
      of: MeasureSourceSpec,
      per: MeasureSourceSpec,
      scale: Schema.optionalKey(Schema.Finite),
    }),
  }),
  Schema.Struct({ command: Schema.String, pattern: Schema.optionalKey(Schema.String) }),
]);

type MeasureSpec = typeof MeasureSpec.Type;
export type MeasureSourceSpec = typeof MeasureSourceSpec.Type;

// Whether any source of the measure is one a probe must prove: a report or
// a function, which can drift into measuring nothing.
const measureNeedsProbe = (measure: MeasureSpec): boolean => {
  const sources = "ratio" in measure ? [measure.ratio.of, measure.ratio.per] : [measure];
  return sources.some((one) => "report" in one || "fn" in one);
};

// An objective: a detector with a ledger that only shrinks on its own. The
// `holdout` says what one ledger entry is; `match` is a per-file detector
// and `sector` a term over the sector's files, exactly one of them.
// `until` names the phase at which it stops counting. A scalar objective
// has a `measure` in place of both, a `direction`, a `tolerance` either side
// of its record, and the `target` at which it is met.
const Objective = Schema.Struct({
  // What a reader at a holdout does about it — the message every hit
  // carries; falls back to the campaign's.
  how: Schema.optionalKey(Schema.String),
  why: Schema.optionalKey(Schema.String),
  holdout: Schema.optionalKey(Holdout),
  match: Schema.optionalKey(DetectorRef),
  sector: Schema.optionalKey(SectorTermSpec),
  measure: Schema.optionalKey(MeasureSpec),
  direction: Schema.optionalKey(Schema.Literals(["down", "up"])),
  tolerance: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  target: Schema.optionalKey(Schema.Finite),
  until: Schema.optionalKey(KebabId),
  probes: Schema.optionalKey(CampaignProbes),
}).check(
  Schema.makeFilter((objective) => {
    const issues: Array<Schema.FilterIssue> = [];
    const named = [objective.match, objective.sector, objective.measure].filter(
      (one) => one !== undefined,
    ).length;
    if (named !== 1) {
      issues.push(
        "an objective names exactly one of `match` (a detector over each file), `sector` (a term over the sector's files) and `measure` (a number per sector)",
      );
    }
    if (objective.measure !== undefined) {
      if (objective.holdout !== undefined) {
        issues.push({
          path: ["holdout"],
          issue: "a `measure` objective holds nothing out: it is a number, so drop `holdout`",
        });
      }
      if (objective.direction === undefined) {
        issues.push({
          path: ["direction"],
          issue:
            "a `measure` objective states which way is better: `direction: down` or `direction: up`",
        });
      }
      if ("command" in objective.measure && objective.probes !== undefined) {
        issues.push({
          path: ["probes"],
          issue:
            "a `command` measure is a number about the repository, which no probe of one file can stand in for: drop `probes`",
        });
      } else if (
        measureNeedsProbe(objective.measure) &&
        (objective.probes?.fires.length ?? 0) === 0
      ) {
        issues.push({
          path: ["probes"],
          issue:
            "a `measure` with a `report` or `fn` source carries `probes.fires`: at least one file it must measure above zero",
        });
      }
      return issues;
    }
    for (const key of ["direction", "tolerance", "target"] as const) {
      if (objective[key] !== undefined) {
        issues.push({ path: [key], issue: `\`${key}\` belongs to a \`measure\` objective` });
      }
    }
    if (objective.holdout === undefined) {
      issues.push({
        path: ["holdout"],
        issue:
          "an objective with `match` or `sector` says what one holdout is: `holdout: file`, `declaration`, `match` or `sector`",
      });
    }
    if (
      objective.sector !== undefined &&
      objective.holdout !== undefined &&
      objective.holdout !== "sector"
    ) {
      issues.push({
        path: ["holdout"],
        issue: "a `sector` objective's holdout is the sector: write `holdout: sector`",
      });
    }
    if (objective.match !== undefined && objective.holdout === "sector") {
      issues.push({
        path: ["holdout"],
        issue: "a `match` objective's holdout is `file`, `declaration` or `match`",
      });
    }
    if (objective.match !== undefined && (objective.probes?.fires.length ?? 0) === 0) {
      issues.push({
        path: ["probes"],
        issue:
          "a `match` objective carries `probes.fires`: at least one source it must report, as every rule proves it can fire",
      });
    }
    return issues;
  }),
);

// How a sector is recognized. `file`: one per file, keyed by the path without
// its extension. `nx`: the workspace's projects. `{ glob }`: one per match.
// `{ marker }`: a file that names the sector — an exported `sector` object
// with `name` and the globs it `owns`; without one, the folder. `{ match }`:
// one per detector match, keyed by its anchor, and proven by probes at least
// one of which is a sector in its end shape.
const PerimeterSpec = Schema.Union([
  Schema.Literals(["file", "nx"]),
  Schema.Struct({ glob: Globs }),
  Schema.Struct({
    marker: Globs,
    probes: Schema.optionalKey(
      Schema.Struct({ fires: Schema.optionalKey(Globs), ignores: Schema.optionalKey(Globs) }),
    ),
  }),
  Schema.Struct({
    match: DetectorRef,
    holdout: Schema.optionalKey(Schema.Literals(["declaration", "match"])),
    probes: CampaignProbes,
  }),
]);

const OnTouchSpec = Schema.Literals(["advise", "ratchet", "paydown"]);

// A receipt for a change to a defined phase: a reason, dated.
const PhaseConcessionSpec = Schema.Struct({
  reason: Schema.String,
  at: Schema.String,
  by: Schema.optionalKey(Schema.String),
});

// A sector-relative node tree: one root, `~/`, standing for the sector,
// shaped like the manifest's own tree with one allow entry of its own —
// `{ sector, via }`, another sector through its port. Carried as written
// and decoded as a tree once the lowering has rebased it for a sector, so
// the node codec itself never learns the extra entry.
const EndStateSpec = Schema.Record(Schema.String, Schema.Unknown);
// A phase: a named, ordered group of objectives. Defined when it names one
// (or is `attested`, or carries an `endState`); open when it has only an
// intent, and then it is last.
const Phase = Schema.Struct({
  id: KebabId,
  intent: Schema.optionalKey(Schema.String),
  objectives: Schema.optionalKey(Schema.Array(KebabId)),
  attested: Schema.optionalKey(Schema.Boolean),
  onTouch: Schema.optionalKey(OnTouchSpec),
  endState: Schema.optionalKey(EndStateSpec),
  concessions: Schema.optionalKey(Schema.Array(PhaseConcessionSpec)),
});

// The scope, as globs or with the extensions the campaign widens the walk
// to beyond the packs' own.
const ScopeSpec = Schema.Union([
  Globs,
  Schema.Struct({ path: Globs, extensions: Schema.optionalKey(Schema.Array(Schema.String)) }),
]);

// A campaign: one multi-step refactor with an end. Everything above
// `objectives` is optional, so a one-objective campaign is the minimal form.
const Campaign = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  why: Schema.optionalKey(Schema.String),
  // The message a holdout carries when its objective states no `how`.
  how: Schema.optionalKey(Schema.String),
  owner: Schema.optionalKey(Schema.String),
  // Which files the campaign sees. Alias-aware globs, as the graph rules
  // take; a campaign's reach is its scope, so it joins no coverage row.
  // Defaults to every file.
  scope: Schema.optionalKey(ScopeSpec),
  // What the unclaimed remainder of the scope counts as; absent, all of it.
  legacy: Schema.optionalKey(Globs),
  perimeter: Schema.optionalKey(PerimeterSpec),
  onTouch: Schema.optionalKey(OnTouchSpec),
  phases: Schema.optionalKey(Schema.Array(Phase)),
  // Sugar for the last phase's end state.
  endState: Schema.optionalKey(EndStateSpec),
  objectives: Schema.Record(KebabId, Objective),
  staleAfter: Schema.optionalKey(Duration),
  onComplete: Schema.optionalKey(Schema.Literals(["keep", "remove"])),
});

// The slice of the manifest this family owns: the `campaigns` map, and the
// directory its ledgers are written under. @goodbones/core splits these two
// keys off the expanded manifest and hands them here; everything the core
// decodes, it decodes without them.
export const CampaignsManifest = Schema.Struct({
  campaigns: Schema.optionalKey(Schema.Record(KebabId, Campaign)),
  // Where the ledgers are written: `<ledger>/<campaign>/<objective>.json`,
  // relative to the manifest. Defaults to `.architecture-campaigns`.
  ledger: Schema.optionalKey(Schema.String),
});

export type CampaignsManifest = typeof CampaignsManifest.Type;
export type CampaignSpec = typeof Campaign.Type;
export type ObjectiveSpec = typeof Objective.Type;
export type PhaseSpec = typeof Phase.Type;
export type PerimeterSpec = typeof PerimeterSpec.Type;
export type SectorTermSpec = typeof SectorTermSpec.Type;
export type EndStateSpec = typeof EndStateSpec.Type;
export type CampaignProbeSpec = typeof CampaignProbe.Type;
export type CampaignProbesSpec = typeof CampaignProbes.Type;
export type SyntaxTermSpec = typeof SyntaxTerm.Type;

export const DEFAULT_LEDGER_DIR = ".architecture-campaigns";

// `30d` -> milliseconds. The schema has already refused any other shape.
export const durationMs = (duration: string): number => {
  const amount = Number(duration.slice(0, -1));
  return amount * (duration.endsWith("h") ? 3_600_000 : 86_400_000);
};
