import {
  type BindingKind,
  compilePatterns,
  type DeclarationKind,
  type ExportSite,
  type FactExtractor,
  type FileSystem,
  type ImportProbeTarget,
  ImportUnresolved,
  type MemberSite,
  type MemberSubject,
  type ModuleResolver,
  PatternInvalid,
  probeTargetOf,
  type ResolvedTarget,
  siblingsOf,
  type SourceFacts,
  type SyntaxMatch,
  type SyntaxMatcher,
  type SyntaxTree,
  type Violation,
} from "@goodbones/core";
import * as Result from "effect/Result";

import type {
  CampaignProbe,
  CampaignRule,
  CampaignUnit,
  Detector,
  Holdout,
  ObjectiveRule,
  OnTouch,
  PerimeterRule,
  PhaseRule,
  ReportFormat,
} from "../domain/config.js";
import type { CampaignPredicate, Range } from "../ports/campaign-predicate.js";
import type { ReportSource, ReportSpec } from "../ports/report-source.js";

// A campaign is one multi-step refactor: `objectives` — each a rule, a
// baseline and a conformance measure with one thing the other families lack,
// a way to name a pattern the import graph cannot see — over `sectors` the
// code declares through a `perimeter`, through ordered `phases`. This module
// compiles a campaign and evaluates one objective on one file; the sectors
// and the phases are `sectors.ts` and `phases.ts`. The detector is a
// predicate algebra — `all`, `any`, `not` — over leaf terms borrowed from
// the other families (`path`, `imports`, `exports`, `members`, `requires`)
// and three of its own (`content`, `syntax`, `fn`).
//
// An objective declares what a holdout is: `file`, `declaration` or `match`
// (or `sector`, for a term over the sector's files, which `sectors.ts`
// answers). The unit
// decides what a term from another level means. In a `file` campaign every
// term is existential — "the file contains one" — and `not` is "contains
// none". In a `declaration` or `match` campaign the candidates are what the
// declaration- and match-level terms produce, a file-level term is a filter
// over all of them, and `not` is the complement within those candidates. So
// `all: [syntax A, not syntax B]` is the declarations A matches that B does
// not, and `not syntax B` alone is nothing at all: there is no universe of
// "every other declaration" to draw from, and saying so is the honest answer.
//
// Evaluation is in two passes. The leaves are evaluated in order of cost —
// the path first, then the facts the extractor already produced, then the
// file system, the text, the syntax tree, and last a predicate function —
// with an `all` stopping at the first file-level term that fails. Every
// candidate the leaves produced is then judged against the whole detector.

export type {
  CampaignPredicate,
  CampaignPredicateInput,
  CampaignSubject,
  Range,
} from "../ports/campaign-predicate.js";

type Target =
  | { readonly kind: "path"; readonly pattern: RegExp }
  | { readonly kind: "external"; readonly name: string }
  | { readonly kind: "builtin"; readonly name: string };

type CompiledNarrowing = {
  readonly capture: string;
  readonly regex: RegExp | null;
  readonly binding: {
    readonly resolves: Target;
    readonly member: ReadonlyArray<string> | null;
  } | null;
};

export type CompiledDetector =
  | { readonly kind: "all"; readonly terms: ReadonlyArray<CompiledDetector> }
  | { readonly kind: "any"; readonly terms: ReadonlyArray<CompiledDetector> }
  | { readonly kind: "not"; readonly term: CompiledDetector }
  | {
      readonly kind: "path";
      readonly file: ReadonlyArray<RegExp>;
      readonly fileNot: ReadonlyArray<RegExp>;
      readonly subject: number | null;
      readonly convention: RegExp | null;
    }
  | {
      readonly kind: "imports";
      readonly resolves: Target;
      readonly symbols: ReadonlyArray<string> | null;
    }
  | {
      readonly kind: "exports";
      readonly name: ReadonlyArray<RegExp>;
      readonly kinds: ReadonlyArray<BindingKind> | null;
      readonly declares: ReadonlyArray<DeclarationKind> | null;
      readonly reexport: boolean | null;
    }
  | {
      readonly kind: "members";
      readonly subject: MemberSubject;
      readonly name: ReadonlyArray<RegExp>;
      readonly in: ReadonlyArray<RegExp>;
      readonly declares: ReadonlyArray<DeclarationKind> | null;
    }
  | { readonly kind: "requires"; readonly templates: ReadonlyArray<string> }
  | { readonly kind: "content"; readonly regex: RegExp }
  | {
      readonly kind: "syntax";
      readonly rule: unknown;
      readonly where: ReadonlyArray<CompiledNarrowing>;
    }
  | {
      readonly kind: "report";
      readonly command: ReadonlyArray<string> | null;
      readonly file: ReadonlyArray<string> | null;
      readonly format: ReportFormat;
      readonly pattern: string | null;
      readonly codes: ReadonlySet<string> | null;
      readonly codesNot: ReadonlySet<string>;
    }
  | { readonly kind: "fn"; readonly name: string };

export type CompiledSectorTerm =
  | { readonly kind: "has"; readonly detect: CompiledDetector }
  | { readonly kind: "oneRoot" }
  | { readonly kind: "oneHost"; readonly hosts: ReadonlyArray<RegExp> };

export type CompiledObjective = {
  readonly name: string;
  readonly id: string;
  readonly campaign: string;
  readonly message: string;
  readonly why: string | null;
  readonly holdout: Holdout;
  // The unit a per-file detector answers at; `declaration` for the
  // objectives no per-file detector answers, whose entries are `file#subject`.
  readonly unit: CampaignUnit;
  readonly detect: CompiledDetector | null;
  readonly sector: CompiledSectorTerm | null;
  readonly endState: { readonly phase: string; readonly family: string } | null;
  readonly until: string | null;
  readonly probes: {
    readonly fires: ReadonlyArray<CampaignProbe>;
    readonly ignores: ReadonlyArray<CampaignProbe>;
  };
};

export type CompiledPerimeter =
  | { readonly kind: "file" }
  | { readonly kind: "nx" }
  | { readonly kind: "glob"; readonly glob: ReadonlyArray<RegExp> }
  | {
      readonly kind: "marker";
      readonly marker: ReadonlyArray<RegExp>;
      readonly probes: {
        readonly fires: ReadonlyArray<string>;
        readonly ignores: ReadonlyArray<string>;
      } | null;
    }
  | {
      readonly kind: "match";
      readonly detect: CompiledDetector;
      readonly unit: "declaration" | "match";
      readonly probes: {
        readonly fires: ReadonlyArray<CampaignProbe>;
        readonly ignores: ReadonlyArray<CampaignProbe>;
      };
    };

export type CompiledCampaign = {
  readonly name: string;
  readonly id: string;
  readonly title: string | null;
  readonly why: string | null;
  readonly owner: string | null;
  readonly scope: ReadonlyArray<RegExp>;
  readonly extensions: ReadonlyArray<string>;
  readonly legacy: ReadonlyArray<RegExp> | null;
  readonly perimeter: CompiledPerimeter | null;
  readonly onTouch: OnTouch | null;
  readonly phases: ReadonlyArray<PhaseRule>;
  readonly objectives: ReadonlyArray<CompiledObjective>;
  readonly staleAfter: number | null;
  readonly onComplete: "keep" | "remove";
};

const targetOf = (
  name: string,
  field: string,
  resolves: ImportProbeTarget,
): Result.Result<Target, PatternInvalid> => {
  if (typeof resolves === "string") {
    const compiled = compilePatterns(name, field, resolves);
    if (Result.isFailure(compiled)) return Result.fail(compiled.failure);
    const [pattern] = compiled.success;
    return pattern === undefined
      ? Result.fail(
          new PatternInvalid({ ruleName: name, field, pattern: resolves, detail: "empty pattern" }),
        )
      : Result.succeed({ kind: "path", pattern });
  }
  if ("external" in resolves) return Result.succeed({ kind: "external", name: resolves.external });
  return Result.succeed({ kind: "builtin", name: resolves.builtin });
};

const compileDetector = (
  name: string,
  detector: Detector,
): Result.Result<CompiledDetector, PatternInvalid> => {
  const compileAll = (
    terms: ReadonlyArray<Detector>,
  ): Result.Result<ReadonlyArray<CompiledDetector>, PatternInvalid> => {
    const compiled: Array<CompiledDetector> = [];
    for (const term of terms) {
      const one = compileDetector(name, term);
      if (Result.isFailure(one)) return Result.fail(one.failure);
      compiled.push(one.success);
    }
    return Result.succeed(compiled);
  };
  const patterns = (field: string, value: string | ReadonlyArray<string> | undefined) =>
    compilePatterns(name, field, value);

  if ("all" in detector) {
    const terms = compileAll(detector.all);
    return Result.isFailure(terms)
      ? Result.fail(terms.failure)
      : Result.succeed({ kind: "all", terms: terms.success });
  }
  if ("any" in detector) {
    const terms = compileAll(detector.any);
    return Result.isFailure(terms)
      ? Result.fail(terms.failure)
      : Result.succeed({ kind: "any", terms: terms.success });
  }
  if ("not" in detector) {
    const term = compileDetector(name, detector.not);
    return Result.isFailure(term)
      ? Result.fail(term.failure)
      : Result.succeed({ kind: "not", term: term.success });
  }
  if ("path" in detector) {
    const file = patterns("path.file", detector.path.file);
    if (Result.isFailure(file)) return Result.fail(file.failure);
    const fileNot = patterns("path.fileNot", detector.path.fileNot);
    if (Result.isFailure(fileNot)) return Result.fail(fileNot.failure);
    const convention = patterns("path.convention", detector.path.convention);
    if (Result.isFailure(convention)) return Result.fail(convention.failure);
    return Result.succeed({
      kind: "path",
      file: file.success,
      fileNot: fileNot.success,
      subject: detector.path.subject ?? null,
      convention: convention.success[0] ?? null,
    });
  }
  if ("imports" in detector) {
    const resolves = targetOf(name, "imports.resolves", detector.imports.resolves);
    if (Result.isFailure(resolves)) return Result.fail(resolves.failure);
    return Result.succeed({
      kind: "imports",
      resolves: resolves.success,
      symbols: detector.imports.symbols === undefined ? null : [...detector.imports.symbols],
    });
  }
  if ("exports" in detector) {
    const named = patterns("exports.name", detector.exports.name);
    if (Result.isFailure(named)) return Result.fail(named.failure);
    return Result.succeed({
      kind: "exports",
      name: named.success,
      kinds: detector.exports.kinds === undefined ? null : [...detector.exports.kinds],
      declares: detector.exports.declares === undefined ? null : [...detector.exports.declares],
      reexport: detector.exports.reexport ?? null,
    });
  }
  if ("members" in detector) {
    const named = patterns("members.name", detector.members.name);
    if (Result.isFailure(named)) return Result.fail(named.failure);
    const inside = patterns("members.in", detector.members.in);
    if (Result.isFailure(inside)) return Result.fail(inside.failure);
    return Result.succeed({
      kind: "members",
      subject: detector.members.subject,
      name: named.success,
      in: inside.success,
      declares: detector.members.declares === undefined ? null : [...detector.members.declares],
    });
  }
  if ("requires" in detector) {
    return Result.succeed({ kind: "requires", templates: [...detector.requires] });
  }
  if ("content" in detector) {
    // The codec refuses a bare string here; a caller that built the rule by
    // hand can still pass one, and `new RegExp(undefined)` is `/(?:)/`, which
    // matches every file. A detector that fires on everything is refused,
    // not compiled.
    const source: unknown = detector.content.regex;
    if (typeof source !== "string") {
      return Result.fail(
        new PatternInvalid({
          ruleName: name,
          field: "content.regex",
          pattern: String(source),
          detail: "a content term is { regex: <string> }",
        }),
      );
    }
    let regex: RegExp;
    try {
      regex = new RegExp(source, "m");
    } catch (cause) {
      return Result.fail(
        new PatternInvalid({
          ruleName: name,
          field: "content.regex",
          pattern: detector.content.regex,
          detail: String(cause),
        }),
      );
    }
    return Result.succeed({ kind: "content", regex });
  }
  if ("syntax" in detector) {
    const where: Array<CompiledNarrowing> = [];
    for (const [capture, narrowing] of Object.entries(detector.syntax.where ?? {})) {
      const regex = patterns(`syntax.where.${capture}.regex`, narrowing.regex);
      if (Result.isFailure(regex)) return Result.fail(regex.failure);
      let binding: CompiledNarrowing["binding"] = null;
      if (narrowing.binding !== undefined) {
        const resolves = targetOf(
          name,
          `syntax.where.${capture}.binding.resolves`,
          narrowing.binding.resolves,
        );
        if (Result.isFailure(resolves)) return Result.fail(resolves.failure);
        binding = {
          resolves: resolves.success,
          member: narrowing.binding.member === undefined ? null : [...narrowing.binding.member],
        };
      }
      where.push({ capture, regex: regex.success[0] ?? null, binding });
    }
    return Result.succeed({ kind: "syntax", rule: detector.syntax.rule, where });
  }
  if ("report" in detector) {
    const term = detector.report;
    if (term.pattern !== undefined) {
      const pattern = patterns("report.pattern", term.pattern);
      if (Result.isFailure(pattern)) return Result.fail(pattern.failure);
    }
    return Result.succeed({
      kind: "report",
      command: term.command ?? null,
      file: term.file ?? null,
      format: term.format,
      pattern: term.pattern ?? null,
      codes: term.codes === undefined ? null : new Set(term.codes),
      codesNot: new Set(term.codesNot ?? []),
    });
  }
  return Result.succeed({ kind: "fn", name: detector.fn });
};

export const compileObjective = (
  rule: ObjectiveRule,
): Result.Result<CompiledObjective, PatternInvalid> => {
  let detect: CompiledDetector | null = null;
  if (rule.match !== undefined) {
    const compiled = compileDetector(rule.name, rule.match);
    if (Result.isFailure(compiled)) return Result.fail(compiled.failure);
    detect = compiled.success;
  }
  let sector: CompiledSectorTerm | null = null;
  if (rule.sector !== undefined) {
    if ("has" in rule.sector) {
      const compiled = compileDetector(rule.name, rule.sector.has);
      if (Result.isFailure(compiled)) return Result.fail(compiled.failure);
      sector = { kind: "has", detect: compiled.success };
    } else if ("oneRoot" in rule.sector) {
      sector = { kind: "oneRoot" };
    } else {
      const hosts = compilePatterns(rule.name, "sector.oneHost", rule.sector.oneHost);
      if (Result.isFailure(hosts)) return Result.fail(hosts.failure);
      sector = { kind: "oneHost", hosts: hosts.success };
    }
  }
  return Result.succeed({
    name: rule.name,
    id: rule.id,
    campaign: rule.campaign,
    message: rule.message,
    why: rule.why ?? null,
    holdout: rule.holdout,
    unit: rule.holdout === "sector" ? "declaration" : rule.holdout,
    detect,
    sector,
    endState: rule.endState ?? null,
    until: rule.until ?? null,
    probes: rule.probes,
  });
};

const compilePerimeter = (
  name: string,
  perimeter: PerimeterRule,
): Result.Result<CompiledPerimeter, PatternInvalid> => {
  switch (perimeter.kind) {
    case "file":
    case "nx":
      return Result.succeed({ kind: perimeter.kind });
    case "glob": {
      const glob = compilePatterns(name, "perimeter.glob", perimeter.glob);
      return Result.isFailure(glob)
        ? Result.fail(glob.failure)
        : Result.succeed({ kind: "glob", glob: glob.success });
    }
    case "marker": {
      const marker = compilePatterns(name, "perimeter.marker", perimeter.marker);
      if (Result.isFailure(marker)) return Result.fail(marker.failure);
      return Result.succeed({
        kind: "marker",
        marker: marker.success,
        probes:
          perimeter.probes === undefined
            ? null
            : {
                fires: [
                  ...(typeof perimeter.probes.fires === "string"
                    ? [perimeter.probes.fires]
                    : perimeter.probes.fires),
                ],
                ignores: [
                  ...(typeof perimeter.probes.ignores === "string"
                    ? [perimeter.probes.ignores]
                    : perimeter.probes.ignores),
                ],
              },
      });
    }
    case "match": {
      const detect = compileDetector(`${name}/perimeter`, perimeter.match);
      if (Result.isFailure(detect)) return Result.fail(detect.failure);
      return Result.succeed({
        kind: "match",
        detect: detect.success,
        unit: perimeter.unit,
        probes: perimeter.probes,
      });
    }
  }
};

export const compileCampaignRule = (
  rule: CampaignRule,
): Result.Result<CompiledCampaign, PatternInvalid> => {
  const scope = compilePatterns(rule.name, "scope", rule.scope);
  if (Result.isFailure(scope)) return Result.fail(scope.failure);
  const legacy = compilePatterns(rule.name, "legacy", rule.legacy);
  if (Result.isFailure(legacy)) return Result.fail(legacy.failure);
  let perimeter: CompiledPerimeter | null = null;
  if (rule.perimeter !== undefined) {
    const compiled = compilePerimeter(rule.name, rule.perimeter);
    if (Result.isFailure(compiled)) return Result.fail(compiled.failure);
    perimeter = compiled.success;
  }
  const objectives: Array<CompiledObjective> = [];
  for (const objective of rule.objectives) {
    const one = compileObjective(objective);
    if (Result.isFailure(one)) return Result.fail(one.failure);
    objectives.push(one.success);
  }
  return Result.succeed({
    name: rule.name,
    id: rule.id,
    title: rule.title ?? null,
    why: rule.why ?? null,
    owner: rule.owner ?? null,
    scope: scope.success,
    extensions: rule.extensions,
    legacy: rule.legacy === undefined ? null : legacy.success,
    perimeter,
    onTouch: rule.onTouch ?? null,
    phases: rule.phases,
    objectives,
    staleAfter: rule.staleAfter ?? null,
    onComplete: rule.onComplete,
  });
};

export const compileCampaignRules = (
  rules: ReadonlyArray<CampaignRule>,
): Result.Result<ReadonlyArray<CompiledCampaign>, PatternInvalid> => {
  const compiled: Array<CompiledCampaign> = [];
  for (const rule of rules) {
    const one = compileCampaignRule(rule);
    if (Result.isFailure(one)) return Result.fail(one.failure);
    compiled.push(one.success);
  }
  return Result.succeed(compiled);
};

const anyMatches = (patterns: ReadonlyArray<RegExp>, value: string): boolean =>
  patterns.some((pattern) => pattern.test(value));

export const campaignsSelecting = (
  rules: ReadonlyArray<CompiledCampaign>,
  file: string,
): ReadonlyArray<CompiledCampaign> => rules.filter((rule) => anyMatches(rule.scope, file));

// The objectives a host evaluates per file: those with a per-file detector.
export const perFileObjectivesOf = (rule: CompiledCampaign): ReadonlyArray<CompiledObjective> =>
  rule.objectives.filter((objective) => objective.detect !== null);

// Whether any of these detectors reads the syntax tree — the parse a host
// skips when none does.
export const needsSyntax = (detectors: ReadonlyArray<CompiledDetector>): boolean =>
  detectors.some((detect) =>
    leafTermsOf(detect).some((leaf) => leaf === "syntax" || leaf === "report" || leaf === "fn"),
  );

// The leaf terms the compiled detector holds, in the order the evaluator
// ranks them by cost.
const LEAF_ORDER = [
  "path",
  "imports",
  "exports",
  "members",
  "requires",
  "content",
  "syntax",
  "report",
  "fn",
] as const;

type LeafKind = (typeof LEAF_ORDER)[number];

const costOf = (detector: CompiledDetector): number => {
  switch (detector.kind) {
    case "all":
    case "any":
      return Math.max(0, ...detector.terms.map(costOf));
    case "not":
      return costOf(detector.term);
    default:
      return LEAF_ORDER.indexOf(detector.kind);
  }
};

const byCost = (terms: ReadonlyArray<CompiledDetector>): ReadonlyArray<CompiledDetector> =>
  [...terms].sort((left, right) => costOf(left) - costOf(right));

export const leafTermsOf = (detector: CompiledDetector): ReadonlyArray<LeafKind> => {
  switch (detector.kind) {
    case "all":
    case "any":
      return detector.terms.flatMap(leafTermsOf);
    case "not":
      return leafTermsOf(detector.term);
    default:
      return [detector.kind];
  }
};

// What the evaluator is given for one file. `syntax` is the file parsed by
// the scope's matcher, or `null` when there is none — a `syntax` term then
// matches nothing. `functions` holds every `fn` the loader imported.
export type CampaignInput = {
  readonly file: string;
  readonly text: string;
  readonly facts: SourceFacts;
  readonly resolver: ModuleResolver;
  readonly fileSystem: FileSystem;
  readonly syntax: SyntaxTree | null;
  readonly functions: ReadonlyMap<string, CampaignPredicate>;
  // Answers a `report` term: the live source runs the command once per
  // process; a probe answers from the diagnostics it lists.
  readonly reports: ReportSource;
};

export type CampaignHit = {
  readonly violation: Violation;
  readonly campaign: string;
  readonly objective: string;
  readonly range?: Range;
};

// A candidate the leaves produced: a declaration by name, or a match by its
// anchor and a hash of its text. The key is the violation's subject.
type Candidate = {
  readonly key: string;
  readonly anchor: string | null;
  readonly range: Range | null;
};

// What one leaf answered: a verdict about the file, or the candidates it
// found — declarations by name, matches by key.
type LeafAnswer =
  | { readonly level: "file"; readonly holds: boolean }
  | {
      readonly level: "declaration";
      readonly names: ReadonlySet<string>;
      readonly candidates: ReadonlyArray<Candidate>;
    }
  | {
      readonly level: "match";
      readonly anchors: ReadonlySet<string>;
      readonly candidates: ReadonlyArray<Candidate>;
    };

// A short, stable hash of a match's text, so a `match` subject survives the
// declaration around it being edited and changes only when the match does.
// FNV-1a, so the core needs no hashing library.
const contentHash = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const matchKeyOf = (anchor: string | null, text: string): string =>
  `${anchor ?? ""}#${contentHash(text)}`;

// Two matches with the same key — the same text twice in one declaration,
// the same diagnostic twice on one line — are two entries, not one: the
// second is `key~2`, the third `key~3`. The ordinal is positional only among
// duplicates, so a ledger keeps its count under any edit that leaves them
// duplicates.
const uniqueKeys = (): ((key: string) => string) => {
  const seen = new Map<string, number>();
  return (key) => {
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? key : `${key}~${String(count)}`;
  };
};

const targetMatches = (target: Target, resolved: ResolvedTarget): boolean => {
  switch (target.kind) {
    case "path":
      return target.pattern.test(resolved.path);
    case "external":
      return resolved.kind === "external" && resolved.package === target.name;
    case "builtin":
      return resolved.kind === "builtin" && resolved.path === target.name;
  }
};

const exportGoverned = (
  term: Extract<CompiledDetector, { kind: "exports" }>,
  site: ExportSite,
): boolean => {
  if (term.kinds !== null && !term.kinds.includes(site.kind)) return false;
  if (term.declares !== null && !term.declares.includes(site.declares)) return false;
  if (term.reexport !== null && term.reexport !== site.reexport) return false;
  if (term.name.length > 0 && !anyMatches(term.name, site.name)) return false;
  return true;
};

const memberGoverned = (
  term: Extract<CompiledDetector, { kind: "members" }>,
  site: MemberSite,
): boolean => {
  if (term.subject !== site.subject) return false;
  if (term.in.length > 0 && (site.in === undefined || !anyMatches(term.in, site.in))) return false;
  if (
    term.declares !== null &&
    (site.declares === undefined || !term.declares.includes(site.declares))
  ) {
    return false;
  }
  if (term.name.length > 0 && !anyMatches(term.name, site.name)) return false;
  return true;
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*/;
const ACCESSED = /^\s*\.\s*([A-Za-z_$][\w$]*)/;

// A capture narrowed by what its root identifier is bound to: the binding
// with that local name, the module its edge resolves to, and the name it
// pulled across — the exported name for a named import, the member accessed
// for a default or namespace one.
const bindingAdmits = (
  narrowing: NonNullable<CompiledNarrowing["binding"]>,
  captured: string,
  input: CampaignInput,
): boolean => {
  const root = IDENTIFIER.exec(captured)?.[0];
  if (root === undefined) return false;
  for (const specifier of input.facts.specifiers) {
    for (const binding of input.facts.bindings.get(specifier) ?? []) {
      if (binding.local !== root) continue;
      const resolved = input.resolver.resolve(input.file, specifier);
      if (Result.isFailure(resolved)) return false;
      if (!targetMatches(narrowing.resolves, resolved.success)) return false;
      if (narrowing.member === null) return true;
      const accessed =
        binding.kind === "named" ? binding.symbol : ACCESSED.exec(captured.slice(root.length))?.[1];
      return accessed !== undefined && narrowing.member.includes(accessed);
    }
  }
  return false;
};

const narrowed = (
  where: ReadonlyArray<CompiledNarrowing>,
  match: SyntaxMatch,
  input: CampaignInput,
): boolean =>
  where.every((one) => {
    const captured = match.captures.get(one.capture);
    if (captured === undefined) return false;
    if (one.regex !== null && !one.regex.test(captured)) return false;
    if (one.binding !== null && !bindingAdmits(one.binding, captured, input)) return false;
    return true;
  });

const declarationsOf = (
  names: Iterable<string>,
  ranges: ReadonlyMap<string, Range> = new Map(),
): LeafAnswer => {
  const set = new Set(names);
  return {
    level: "declaration",
    names: set,
    candidates: [...set].map((name) => ({
      key: name,
      anchor: name,
      range: ranges.get(name) ?? null,
    })),
  };
};

const matchesOf = (candidates: ReadonlyArray<Candidate>): LeafAnswer => ({
  level: "match",
  anchors: new Set(candidates.flatMap((one) => (one.anchor === null ? [] : [one.anchor]))),
  candidates,
});

const evaluateLeaf = (term: CompiledDetector, input: CampaignInput): LeafAnswer => {
  switch (term.kind) {
    case "path": {
      if (anyMatches(term.fileNot, input.file)) return { level: "file", holds: false };
      for (const pattern of term.file) {
        const found = pattern.exec(input.file);
        if (found === null) continue;
        if (term.convention === null || term.subject === null) {
          return { level: "file", holds: true };
        }
        const subject = found[term.subject];
        return { level: "file", holds: subject !== undefined && term.convention.test(subject) };
      }
      return { level: "file", holds: false };
    }
    case "imports": {
      for (const specifier of input.facts.specifiers) {
        if (term.symbols !== null) {
          const bound = input.facts.bindings.get(specifier) ?? [];
          const wanted = term.symbols;
          if (!bound.some((binding) => wanted.includes(binding.symbol))) continue;
        }
        const resolved = input.resolver.resolve(input.file, specifier);
        if (Result.isFailure(resolved)) continue;
        if (targetMatches(term.resolves, resolved.success)) return { level: "file", holds: true };
      }
      return { level: "file", holds: false };
    }
    case "exports":
      return declarationsOf(
        input.facts.exportSites
          .filter((site) => exportGoverned(term, site))
          .map((site) => site.name),
      );
    case "members": {
      const sites = input.facts.memberSites.filter((site) => memberGoverned(term, site));
      // A called name sits in no declaration the facts know, so a `calls`
      // term is a statement about the file.
      if (term.subject === "calls") return { level: "file", holds: sites.length > 0 };
      return declarationsOf(sites.flatMap((site) => (site.in === undefined ? [] : [site.in])));
    }
    case "requires":
      return {
        level: "file",
        holds: siblingsOf(term.templates, input.file).every((sibling) =>
          input.fileSystem.exists(sibling),
        ),
      };
    case "content":
      return { level: "file", holds: term.regex.test(input.text) };
    case "syntax": {
      if (input.syntax === null) return matchesOf([]);
      const unique = uniqueKeys();
      const candidates: Array<Candidate> = [];
      for (const match of input.syntax.findAll(term.rule)) {
        if (!narrowed(term.where, match, input)) continue;
        candidates.push({
          key: unique(matchKeyOf(match.anchor, match.text)),
          anchor: match.anchor,
          range: match.range,
        });
      }
      return matchesOf(candidates);
    }
    case "report": {
      // Each diagnostic is a match: anchored on the declaration at its
      // position (or none, at the top level or without a matcher), keyed by
      // its code and a hash of its message — so an entry survives the line
      // moving and changes when the message does.
      const unique = uniqueKeys();
      const candidates: Array<Candidate> = [];
      for (const diagnostic of input.reports.diagnosticsOf(specOf(term), input.file)) {
        if (term.codes !== null && !term.codes.has(diagnostic.code)) continue;
        if (term.codesNot.has(diagnostic.code)) continue;
        const position = { line: diagnostic.line, column: diagnostic.column };
        const anchor = input.syntax?.anchorAt(position) ?? null;
        const code = diagnostic.code === "" ? "" : `${diagnostic.code}#`;
        candidates.push({
          key: unique(`${anchor ?? ""}#${code}${contentHash(diagnostic.message)}`),
          anchor,
          range: { start: position, end: position },
        });
      }
      return matchesOf(candidates);
    }
    case "fn": {
      const predicate = input.functions.get(term.name);
      if (predicate === undefined) return { level: "file", holds: false };
      const answer = predicate({
        file: input.file,
        text: input.text,
        facts: input.facts,
        syntax: input.syntax,
      });
      if (typeof answer === "boolean") return { level: "file", holds: answer };
      return matchesOf(
        answer.map((one) => ({ key: one.subject, anchor: one.subject, range: one.range ?? null })),
      );
    }
    default:
      throw new Error(`not a leaf: ${term.kind}`);
  }
};

// Whether every leaf under a node answers about the file, in which case the
// node has one boolean answer and an `all` may stop at it.
const isFileLevel = (term: CompiledDetector, unit: CampaignUnit): boolean =>
  unit === "file" ||
  leafTermsOf(term).every(
    (leaf) =>
      leaf !== "exports" &&
      leaf !== "members" &&
      leaf !== "syntax" &&
      leaf !== "report" &&
      leaf !== "fn",
  );

type Evaluation = {
  readonly answers: Map<CompiledDetector, LeafAnswer>;
  readonly leaf: (term: CompiledDetector) => LeafAnswer;
};

// Whether a leaf answer holds for one candidate. A file-level answer holds
// for every candidate or none; a declaration-level one for the candidate
// named (or, for a match, the one anchored there); a match-level one for the
// candidate keyed (or, for a declaration, the one some match is anchored in).
const holdsFor = (answer: LeafAnswer, candidate: Candidate, unit: CampaignUnit): boolean => {
  switch (answer.level) {
    case "file":
      return answer.holds;
    case "declaration":
      return unit === "match"
        ? candidate.anchor !== null && answer.names.has(candidate.anchor)
        : answer.names.has(candidate.key);
    case "match":
      return unit === "declaration"
        ? answer.anchors.has(candidate.key)
        : answer.candidates.some((one) => one.key === candidate.key);
  }
};

// In a `file` campaign every term is existential.
const holdsAtAll = (answer: LeafAnswer): boolean =>
  answer.level === "file" ? answer.holds : answer.candidates.length > 0;

const judge = (
  term: CompiledDetector,
  candidate: Candidate | null,
  unit: CampaignUnit,
  evaluation: Evaluation,
): boolean => {
  switch (term.kind) {
    case "all":
      return term.terms.every((one) => judge(one, candidate, unit, evaluation));
    case "any":
      return term.terms.some((one) => judge(one, candidate, unit, evaluation));
    case "not":
      return !judge(term.term, candidate, unit, evaluation);
    default: {
      const answer = evaluation.leaf(term);
      return candidate === null ? holdsAtAll(answer) : holdsFor(answer, candidate, unit);
    }
  }
};

// The first pass: evaluate the leaves that decide anything, cheapest first.
// An `all` stops at a file-level child that fails — nothing after it can
// rescue the conjunction, and the terms after it are the expensive ones. An
// `any` in a `file` campaign stops at a child that holds; in the other units
// it goes on, because the other branches are where the candidates come from.
const prepare = (
  term: CompiledDetector,
  unit: CampaignUnit,
  evaluation: Evaluation,
): boolean | null => {
  switch (term.kind) {
    case "all": {
      for (const child of byCost(term.terms)) {
        const verdict = prepare(child, unit, evaluation);
        if (verdict === false) return false;
      }
      return null;
    }
    case "any": {
      for (const child of byCost(term.terms)) {
        const verdict = prepare(child, unit, evaluation);
        if (verdict === true && unit === "file") return true;
      }
      return null;
    }
    case "not": {
      const verdict = prepare(term.term, unit, evaluation);
      return verdict === null ? null : !verdict;
    }
    default: {
      if (!isFileLevel(term, unit)) {
        evaluation.leaf(term);
        return null;
      }
      return holdsAtAll(evaluation.leaf(term));
    }
  }
};

const FILE_CANDIDATE: Candidate = { key: "", anchor: null, range: null };

const evaluationOf = (input: CampaignInput): Evaluation => {
  const answers = new Map<CompiledDetector, LeafAnswer>();
  return {
    answers,
    leaf: (term) => {
      const found = answers.get(term);
      if (found !== undefined) return found;
      const answer = evaluateLeaf(term, input);
      answers.set(term, answer);
      return answer;
    },
  };
};

const universeOf = (evaluation: Evaluation, unit: CampaignUnit): ReadonlyArray<Candidate> => {
  const byKey = new Map<string, Candidate>();
  for (const answer of evaluation.answers.values()) {
    if (answer.level === "file") continue;
    if (unit === "declaration" && answer.level === "match") {
      // A match sources the declaration it sits in; one at the top level of
      // the file sits in none and sources nothing.
      for (const one of answer.candidates) {
        if (one.anchor === null || byKey.has(one.anchor)) continue;
        byKey.set(one.anchor, { key: one.anchor, anchor: one.anchor, range: one.range });
      }
      continue;
    }
    if (unit === "match" && answer.level === "declaration") continue;
    for (const one of answer.candidates) if (!byKey.has(one.key)) byKey.set(one.key, one);
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
};

const hitOf = (rule: CompiledObjective, file: string, candidate: Candidate): CampaignHit => ({
  violation: {
    kind: "campaign",
    ruleName: rule.name,
    message: rule.message,
    file,
    subject: rule.unit === "file" ? null : candidate.key,
  },
  campaign: rule.campaign,
  objective: rule.id,
  ...(candidate.range === null ? {} : { range: candidate.range }),
});

// The candidates a detector produces on one file at a unit, as the
// perimeter and the sector terms ask it — without an objective to hang a
// violation on.
export const candidatesOf = (
  detect: CompiledDetector,
  unit: CampaignUnit,
  input: CampaignInput,
): ReadonlyArray<{ readonly key: string; readonly range: Range | null }> => {
  const evaluation = evaluationOf(input);
  const verdict = prepare(detect, unit, evaluation);
  if (unit === "file") {
    const holds = verdict ?? judge(detect, null, "file", evaluation);
    return holds ? [{ key: "", range: null }] : [];
  }
  if (verdict === false) return [];
  return universeOf(evaluation, unit)
    .filter((candidate) => judge(detect, candidate, unit, evaluation))
    .map((candidate) => ({ key: candidate.key, range: candidate.range }));
};

// One objective on one file. An objective with no per-file detector — a
// sector term, an end state — answers nothing here; the host that holds
// the sector's files answers it.
export const evaluateObjective = (
  rule: CompiledObjective,
  input: CampaignInput,
): ReadonlyArray<CampaignHit> => {
  if (rule.detect === null) return [];
  const detect = rule.detect;
  const evaluation = evaluationOf(input);
  const verdict = prepare(detect, rule.unit, evaluation);
  if (rule.unit === "file") {
    const holds = verdict ?? judge(detect, null, "file", evaluation);
    return holds ? [hitOf(rule, input.file, FILE_CANDIDATE)] : [];
  }
  if (verdict === false) return [];
  return universeOf(evaluation, rule.unit)
    .filter((candidate) => judge(detect, candidate, rule.unit, evaluation))
    .map((candidate) => hitOf(rule, input.file, candidate));
};

// What a `report` term asks its source for: the command or file, the format
// and, for `regex`, the pattern. The codes are the term's own filter.
const specOf = (term: Extract<CompiledDetector, { kind: "report" }>): ReportSpec => ({
  ...(term.command === null ? {} : { command: term.command }),
  ...(term.file === null ? {} : { file: term.file }),
  format: term.format,
  ...(term.pattern === null ? {} : { pattern: term.pattern }),
});

// Every distinct report the campaigns name, for a host that asks for them
// before any file: the plugin does, at load, because a `command` forks the
// process that asks, and the linter's process is one Linux can refuse to
// fork once it is linting — its per-thread AST buffers merge into a mapping
// larger than the machine has to give, and the heuristic overcommit mode
// refuses that at fork. At load, the process is small.
export const reportSpecsOf = (
  rules: ReadonlyArray<CompiledCampaign>,
): ReadonlyArray<ReportSpec> => {
  const seen = new Map<string, ReportSpec>();
  const walk = (detector: CompiledDetector): void => {
    switch (detector.kind) {
      case "all":
      case "any":
        for (const term of detector.terms) walk(term);
        return;
      case "not":
        walk(detector.term);
        return;
      case "report": {
        const spec = specOf(detector);
        seen.set(JSON.stringify(spec), spec);
        return;
      }
      default:
        return;
    }
  };
  for (const rule of rules) {
    for (const objective of rule.objectives) {
      if (objective.detect !== null) walk(objective.detect);
      if (objective.sector?.kind === "has") walk(objective.sector.detect);
    }
    if (rule.perimeter?.kind === "match") walk(rule.perimeter.detect);
  }
  return [...seen.values()];
};

export const evaluateObjectives = (
  selected: ReadonlyArray<CompiledObjective>,
  input: CampaignInput,
): ReadonlyArray<CampaignHit> => selected.flatMap((rule) => evaluateObjective(rule, input));

// One line per leaf term: how it reads, and what it answered for this file —
// every leaf evaluated, with no short-circuit, since the point is to show
// which one is not saying what the author thinks it says.
export type TermAnswer = {
  readonly term: string;
  readonly answer: boolean;
  // For a declaration- or match-level term: how many candidates it found.
  readonly count?: number;
};

const describeTerm = (term: CompiledDetector): string => {
  switch (term.kind) {
    case "path":
      return `path ${term.file.map((one) => `/${one.source}/`).join(" | ")}`;
    case "imports":
      return `imports ${describeTarget(term.resolves)}${term.symbols === null ? "" : ` { ${term.symbols.join(", ")} }`}`;
    case "exports":
      return `exports${term.name.length === 0 ? "" : ` ${term.name.map((one) => `/${one.source}/`).join(" | ")}`}${term.kinds === null ? "" : ` [${term.kinds.join(", ")}]`}`;
    case "members":
      return `members (${term.subject})${term.name.length === 0 ? "" : ` ${term.name.map((one) => `/${one.source}/`).join(" | ")}`}`;
    case "requires":
      return `requires ${term.templates.join(", ")}`;
    case "content":
      return `content /${term.regex.source}/`;
    case "syntax":
      return `syntax ${JSON.stringify(term.rule)}`;
    case "report":
      return `report ${term.format} ${term.command === null ? `file ${(term.file ?? []).join(", ")}` : term.command.map((one) => `\`${one}\``).join(", ")}${term.codes === null ? "" : ` [${[...term.codes].join(", ")}]`}`;
    case "fn":
      return `fn ${term.name}`;
    default:
      return term.kind;
  }
};

const describeTarget = (target: Target): string => {
  switch (target.kind) {
    case "path":
      return `/${target.pattern.source}/`;
    case "external":
      return `external ${target.name}`;
    case "builtin":
      return `builtin ${target.name}`;
  }
};

// The detector an objective reads a file with: its own, or the one its
// `has` term quantifies over the sector's files.
export const detectorOf = (rule: CompiledObjective): CompiledDetector | null =>
  rule.detect ?? (rule.sector?.kind === "has" ? rule.sector.detect : null);

export const explainObjective = (
  rule: CompiledObjective,
  input: CampaignInput,
): ReadonlyArray<TermAnswer> => explainDetector(detectorOf(rule), input);

export const explainDetector = (
  detect: CompiledDetector | null,
  input: CampaignInput,
): ReadonlyArray<TermAnswer> => {
  if (detect === null) return [];
  const evaluation = evaluationOf(input);
  const lines: Array<TermAnswer> = [];
  const walk = (term: CompiledDetector, negated: boolean): void => {
    switch (term.kind) {
      case "all":
      case "any":
        for (const one of term.terms) walk(one, negated);
        return;
      case "not":
        walk(term.term, !negated);
        return;
      default: {
        const answer = evaluation.leaf(term);
        lines.push({
          term: `${negated ? "not " : ""}${describeTerm(term)}`,
          answer: holdsAtAll(answer),
          ...(answer.level === "file" ? {} : { count: answer.candidates.length }),
        });
      }
    }
  };
  walk(detect, false);
  return lines;
};

// The input a probe stands in for: its edges answer the resolver, its files
// the file system, its source the extractor and the matcher.
const NOTHING: SourceFacts = {
  specifiers: [],
  bindings: new Map(),
  memberSites: [],
  exportSites: [],
};

export const probeInputOf = (
  probe: CampaignProbe,
  extractor: FactExtractor,
  matcher: SyntaxMatcher | null,
  functions: ReadonlyMap<string, CampaignPredicate>,
): CampaignInput => {
  const edges = probe.edges ?? {};
  const files = new Set(probe.files ?? []);
  const text = probe.source ?? "";
  // The probe's diagnostics, one-based as written, on the probe's own file.
  const reported = (probe.report ?? []).map((one) => ({
    file: probe.path,
    line: Math.max(0, one.line - 1),
    column: Math.max(0, (one.column ?? 1) - 1),
    code: one.code ?? "",
    message: one.message ?? "",
  }));
  return {
    file: probe.path,
    text,
    facts: probe.source === undefined ? NOTHING : extractor.factsOf(probe.path, probe.source),
    resolver: {
      resolve: (fromFile, specifier) => {
        const target = edges[specifier];
        return target === undefined
          ? Result.fail(
              new ImportUnresolved({ fromFile, specifier, detail: "not among the probe's edges" }),
            )
          : Result.succeed(probeTargetOf(target));
      },
    },
    fileSystem: { exists: (at) => files.has(at), readText: () => null, list: () => [] },
    syntax: probe.source === undefined || matcher === null ? null : matcher.parse(probe.path, text),
    functions,
    reports: { diagnosticsOf: (_spec, file) => (file === probe.path ? reported : []) },
  };
};

export type FailedProbe = {
  readonly name: string;
  readonly probe: CampaignProbe;
  readonly expected: "fires" | "ignores" | "end-shape";
  // For an `ignores` probe that fired: the first leaf term that held.
  readonly admittedBy?: string;
  // For a probe outside the campaign's own scope.
  readonly outOfScope?: boolean;
};

// Every objective must fire on each of its `fires` probes and stay silent
// on each of its `ignores` — the same vacuity check every family makes,
// with the second half added because a detector is composed, and the term
// that admits too much is the one the author wants named. A `match`
// perimeter is proven the same way, plus one rule of its own: the perimeter
// is the sector's identity across every phase, so at least one of its
// `fires` probes must be a sector no objective fires on — its end shape —
// or the sector would be un-born the moment the first phase was met.
export const campaignsFailingTheirProbe = (
  rules: ReadonlyArray<CompiledCampaign>,
  extractor: FactExtractor,
  matcherFor: (file: string) => SyntaxMatcher | null,
  functions: ReadonlyMap<string, CampaignPredicate>,
): ReadonlyArray<FailedProbe> => {
  const failed: Array<FailedProbe> = [];
  for (const rule of rules) {
    const check = (
      name: string,
      detect: CompiledDetector,
      unit: CampaignUnit,
      probe: CampaignProbe,
      expected: "fires" | "ignores",
    ): CampaignInput | null => {
      if (!anyMatches(rule.scope, probe.path)) {
        failed.push({ name, probe, expected, outOfScope: true });
        return null;
      }
      const input = probeInputOf(probe, extractor, matcherFor(probe.path), functions);
      const hits = candidatesOf(detect, unit, input);
      if (expected === "fires" && hits.length === 0) failed.push({ name, probe, expected });
      if (expected === "ignores" && hits.length > 0) {
        const admitting = explainDetector(detect, input).find((line) => line.answer);
        failed.push({
          name,
          probe,
          expected,
          ...(admitting === undefined ? {} : { admittedBy: admitting.term }),
        });
      }
      return input;
    };
    for (const objective of rule.objectives) {
      const detect = detectorOf(objective);
      if (detect === null) continue;
      const unit = objective.sector?.kind === "has" ? "file" : objective.unit;
      for (const probe of objective.probes.fires)
        check(objective.name, detect, unit, probe, "fires");
      for (const probe of objective.probes.ignores) {
        check(objective.name, detect, unit, probe, "ignores");
      }
    }
    if (rule.perimeter?.kind === "match") {
      const perimeter = rule.perimeter;
      const name = `${rule.name}/perimeter`;
      let endShape = false;
      for (const probe of perimeter.probes.fires) {
        const input = check(name, perimeter.detect, perimeter.unit, probe, "fires");
        if (input === null) continue;
        const firing = rule.objectives.some(
          (objective) =>
            objective.detect !== null &&
            candidatesOf(objective.detect, objective.unit, input).length > 0,
        );
        if (!firing) endShape = true;
      }
      for (const probe of perimeter.probes.ignores) {
        check(name, perimeter.detect, perimeter.unit, probe, "ignores");
      }
      const [first] = perimeter.probes.fires;
      if (!endShape && first !== undefined) {
        failed.push({ name, probe: first, expected: "end-shape" });
      }
    }
  }
  return failed;
};
