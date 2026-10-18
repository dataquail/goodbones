import * as Result from "effect/Result";

import type {
  BindingKind,
  DeclarationKind,
  SurfaceProbe,
  SurfaceRule,
} from "../domain/architecture-config.js";
import type { PatternInvalid } from "../domain/architecture-error.js";
import type { ExportSite } from "../domain/facts.js";
import type { Violation } from "../domain/violation.js";
import type { FactExtractor } from "../ports/fact-extractor.js";
import { compilePatterns, firstFromMatch } from "./patterns.js";

export type { ExportSite } from "../domain/facts.js";

// What a rule asks of the sites it speaks to. Exactly one per rule: the
// manifest lowers a spec that names several demands into several rules.
export type Demand =
  | { readonly kind: "forbid" }
  | { readonly kind: "allow"; readonly allow: ReadonlyArray<RegExp> }
  | { readonly kind: "convention"; readonly convention: RegExp }
  | { readonly kind: "count"; readonly min: number; readonly max: number };

export type CompiledSurfaceRule = {
  readonly name: string;
  readonly message: string;
  readonly from: ReadonlyArray<RegExp>;
  readonly fromNot: ReadonlyArray<RegExp>;
  readonly kinds: ReadonlyArray<BindingKind> | null;
  readonly declares: ReadonlyArray<DeclarationKind> | null;
  readonly reexport: boolean | null;
  readonly match: ReadonlyArray<RegExp>;
  readonly matchNot: ReadonlyArray<RegExp>;
  readonly demand: Demand;
  readonly probe: SurfaceProbe;
};

const demandOf = (rule: SurfaceRule): Result.Result<Demand, PatternInvalid> => {
  if (rule.allow !== undefined) {
    const allow = compilePatterns(rule.name, "allow", rule.allow);

    if (Result.isFailure(allow)) return Result.fail(allow.failure);

    return Result.succeed({ kind: "allow", allow: allow.success });
  }

  if (rule.convention !== undefined) {
    const convention = compilePatterns(rule.name, "convention", rule.convention);

    if (Result.isFailure(convention)) return Result.fail(convention.failure);
    const [compiled] = convention.success;

    return compiled === undefined
      ? Result.succeed({ kind: "forbid" })
      : Result.succeed({ kind: "convention", convention: compiled });
  }

  if (rule.count !== undefined) {
    return Result.succeed({
      kind: "count",
      min: rule.count.min ?? 0,
      max: rule.count.max ?? Number.POSITIVE_INFINITY,
    });
  }

  return Result.succeed({ kind: "forbid" });
};

export const compileSurfaceRule = (
  rule: SurfaceRule,
): Result.Result<CompiledSurfaceRule, PatternInvalid> => {
  const from = compilePatterns(rule.name, "from", rule.from);

  if (Result.isFailure(from)) return Result.fail(from.failure);
  const fromNot = compilePatterns(rule.name, "fromNot", rule.fromNot);

  if (Result.isFailure(fromNot)) return Result.fail(fromNot.failure);
  const match = compilePatterns(rule.name, "match", rule.match);

  if (Result.isFailure(match)) return Result.fail(match.failure);
  const matchNot = compilePatterns(rule.name, "matchNot", rule.matchNot);

  if (Result.isFailure(matchNot)) return Result.fail(matchNot.failure);
  const demand = demandOf(rule);

  if (Result.isFailure(demand)) return Result.fail(demand.failure);

  return Result.succeed({
    name: rule.name,
    message: rule.message,
    probe: rule.probe,
    from: from.success,
    fromNot: fromNot.success,
    kinds: rule.kinds === undefined ? null : [...rule.kinds],
    declares: rule.declares === undefined ? null : [...rule.declares],
    reexport: rule.reexport ?? null,
    match: match.success,
    matchNot: matchNot.success,
    demand: demand.success,
  });
};

export const compileSurfaceRules = (
  rules: ReadonlyArray<SurfaceRule>,
): Result.Result<ReadonlyArray<CompiledSurfaceRule>, PatternInvalid> => {
  const compiled: Array<CompiledSurfaceRule> = [];

  for (const rule of rules) {
    const one = compileSurfaceRule(rule);

    if (Result.isFailure(one)) return Result.fail(one.failure);
    compiled.push(one.success);
  }

  return Result.succeed(compiled);
};

const anyMatches = (patterns: ReadonlyArray<RegExp>, value: string): boolean =>
  patterns.some((pattern) => pattern.test(value));

export const surfaceRulesSelecting = (
  rules: ReadonlyArray<CompiledSurfaceRule>,
  file: string,
): ReadonlyArray<CompiledSurfaceRule> =>
  rules.filter((rule) => firstFromMatch(rule, file) !== null);

// Whether a site is one the rule speaks to at all.
const governs = (rule: CompiledSurfaceRule, site: ExportSite): boolean => {
  if (rule.kinds !== null && !rule.kinds.includes(site.kind)) return false;

  if (rule.declares !== null && !rule.declares.includes(site.declares)) return false;

  if (rule.reexport !== null && rule.reexport !== site.reexport) return false;

  if (rule.match.length > 0 && !anyMatches(rule.match, site.name)) return false;

  if (rule.matchNot.length > 0 && anyMatches(rule.matchNot, site.name)) return false;

  return true;
};

// A file's whole surface at once, because `count` is a statement about the
// file rather than about any one site. The other demands report per site, on
// the name that is actually restricted.
export const evaluateSurface = (
  selected: ReadonlyArray<CompiledSurfaceRule>,
  file: string,
  sites: ReadonlyArray<ExportSite>,
): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = [];

  const report = (rule: CompiledSurfaceRule, subject: string | null): void => {
    violations.push({ kind: "surface", ruleName: rule.name, message: rule.message, file, subject });
  };

  for (const rule of selected) {
    const spoken = sites.filter((site) => governs(rule, site));
    const demand = rule.demand;

    switch (demand.kind) {
      case "forbid":
        for (const site of spoken) report(rule, site.name);
        break;
      case "allow":
        for (const site of spoken) {
          if (!anyMatches(demand.allow, site.name)) report(rule, site.name);
        }

        break;
      case "convention":
        for (const site of spoken) {
          if (!demand.convention.test(site.name)) report(rule, site.name);
        }

        break;
      case "count":
        if (spoken.length < demand.min || spoken.length > demand.max) report(rule, null);
        break;
    }
  }

  return violations;
};

// The probe is a whole surface — a list of sites, or a source the parser reads
// them out of — because that is what the rule is evaluated against. A rule that
// reports nothing for its own probe enforces nothing.
export const surfaceRulesFailingTheirProbe = (
  rules: ReadonlyArray<CompiledSurfaceRule>,
  extractor: FactExtractor,
): ReadonlyArray<CompiledSurfaceRule> =>
  rules.filter((rule) => {
    if (firstFromMatch(rule, rule.probe.from) === null) return true;

    const sites: ReadonlyArray<ExportSite> =
      rule.probe.source === undefined
        ? (rule.probe.sites ?? []).map((site) => ({
            file: rule.probe.from,
            name: site.name,
            kind: site.kind,
            declares: site.declares ?? "other",
            reexport: site.reexport ?? false,
          }))
        : extractor.factsOf(rule.probe.from, rule.probe.source).exportSites;

    return evaluateSurface([rule], rule.probe.from, sites).length === 0;
  });
