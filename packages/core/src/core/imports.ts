import * as Result from "effect/Result";

import type {
  Allowance,
  ImportProbe,
  ImportProbeTarget,
  ImportRule,
} from "../domain/architecture-config.js";
import type { ImportUnresolved, PatternInvalid } from "../domain/architecture-error.js";
import type { Violation } from "../domain/violation.js";
import type { DependencyKind, ModuleResolver, ResolvedTarget } from "../ports/module-resolver.js";
import {
  compilePatterns,
  firstFromMatch,
  sourcesOf,
  targetAllowed,
  validateTargetPatterns,
} from "./patterns.js";

export type CompiledImportRule = {
  readonly name: string;
  readonly message: string;
  readonly from: ReadonlyArray<RegExp>;
  readonly fromNot: ReadonlyArray<RegExp>;
  // Kept as source strings: a `$1` in a target pattern is substituted from the
  // `from` match before it is compiled, which is how a rule says "any module but
  // my own" without naming every module.
  readonly to: ReadonlyArray<string>;
  readonly toNot: ReadonlyArray<string>;
  // Third-party packages the rule permits, by name. Judged before the path
  // patterns, so where a language keeps its packages never reaches a rule.
  readonly externals: ReadonlySet<string>;
  // Where each `toNot` and external came from, when lowered from a manifest;
  // empty for a hand-written rule. What `slackOf` reads.
  readonly allowances: ReadonlyArray<Allowance>;
  readonly dependencyKind: DependencyKind | null;
  readonly probe: ImportProbe;
};

export const compileImportRule = (
  rule: ImportRule,
): Result.Result<CompiledImportRule, PatternInvalid> => {
  const from = compilePatterns(rule.name, "from", rule.from);
  if (Result.isFailure(from)) return Result.fail(from.failure);
  const fromNot = compilePatterns(rule.name, "fromNot", rule.fromNot);
  if (Result.isFailure(fromNot)) return Result.fail(fromNot.failure);

  const targets = validateTargetPatterns(rule.name, [
    ["to", rule.to],
    ["toNot", rule.toNot],
  ]);
  if (Result.isFailure(targets)) return Result.fail(targets.failure);

  return Result.succeed({
    name: rule.name,
    message: rule.message,
    probe: rule.probe,
    from: from.success,
    fromNot: fromNot.success,
    to: sourcesOf(rule.to),
    toNot: sourcesOf(rule.toNot),
    externals: new Set(rule.externals ?? []),
    allowances: rule.allowances ?? [],
    dependencyKind: rule.dependencyKind ?? null,
  });
};

export const compileImportRules = (
  rules: ReadonlyArray<ImportRule>,
): Result.Result<ReadonlyArray<CompiledImportRule>, PatternInvalid> => {
  const compiled: Array<CompiledImportRule> = [];
  for (const rule of rules) {
    const one = compileImportRule(rule);
    if (Result.isFailure(one)) return Result.fail(one.failure);
    compiled.push(one.success);
  }
  return Result.succeed(compiled);
};

export type ImportEdge = {
  readonly importer: string;
  readonly specifier: string;
};

export type SelectedRule = readonly [CompiledImportRule, RegExpExecArray];

// Returns the rules whose `from` side selects this file. A file no rule selects
// never needs its imports resolved, which is what keeps resolution off the hot
// path for the bulk of the repo.
export const rulesSelecting = (
  rules: ReadonlyArray<CompiledImportRule>,
  importer: string,
): ReadonlyArray<SelectedRule> => {
  const selected: Array<SelectedRule> = [];
  for (const rule of rules) {
    const captures = firstFromMatch(rule, importer);
    if (captures !== null) selected.push([rule, captures]);
  }
  return selected;
};

// Whether the rule reports this target. The kind comes from the resolver, an
// external is judged by its package name, and only then do the path patterns
// speak — so a rule never has to know where a language keeps its packages.
const reports = (rule: CompiledImportRule, captures: RegExpExecArray, target: ResolvedTarget) => {
  if (rule.dependencyKind !== null && rule.dependencyKind !== target.kind) return false;
  if (
    target.kind === "external" &&
    target.package !== undefined &&
    rule.externals.has(target.package)
  ) {
    return false;
  }
  return targetAllowed(rule, captures, target.path);
};

// The same judgement over a target the host has already resolved — for a host
// that resolves each edge once and wants the target for something else too.
export const evaluateResolvedEdge = (
  selected: ReadonlyArray<SelectedRule>,
  importer: string,
  target: ResolvedTarget,
): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = [];
  for (const [rule, captures] of selected) {
    if (reports(rule, captures, target)) {
      violations.push({
        kind: "import",
        ruleName: rule.name,
        message: rule.message,
        file: importer,
        subject: target.path,
      });
    }
  }
  return violations;
};

export const evaluateSelectedEdge = (
  selected: ReadonlyArray<SelectedRule>,
  resolver: ModuleResolver,
  edge: ImportEdge,
): Result.Result<ReadonlyArray<Violation>, ImportUnresolved> => {
  if (selected.length === 0) return Result.succeed([]);

  const resolved = resolver.resolve(edge.importer, edge.specifier);
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure);
  return Result.succeed(evaluateResolvedEdge(selected, edge.importer, resolved.success));
};

export const evaluateImportEdge = (
  rules: ReadonlyArray<CompiledImportRule>,
  resolver: ModuleResolver,
  edge: ImportEdge,
): Result.Result<ReadonlyArray<Violation>, ImportUnresolved> =>
  evaluateSelectedEdge(rulesSelecting(rules, edge.importer), resolver, edge);

// A probe states its target in one of three forms, and the form is the kind —
// so the probe never has to know how a language spells an external's path.
export const probeTargetOf = (to: ImportProbeTarget): ResolvedTarget => {
  if (typeof to === "string") return { path: to, kind: "local" };
  if ("external" in to) return { path: to.external, kind: "external", package: to.external };
  return { path: to.builtin, kind: "builtin" };
};

// Every rule must report its own probe. A rule that does not is enforcing
// nothing while still looking configured and still passing a clean lint run —
// the one failure mode a linter cannot surface on its own.
export const rulesFailingTheirProbe = (
  rules: ReadonlyArray<CompiledImportRule>,
): ReadonlyArray<CompiledImportRule> =>
  rules.filter((rule) => {
    const captures = firstFromMatch(rule, rule.probe.from);
    if (captures === null) return true;
    return !reports(rule, captures, probeTargetOf(rule.probe.to));
  });
