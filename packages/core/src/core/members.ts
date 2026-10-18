import * as Result from "effect/Result";

import type {
  DeclarationKind,
  MemberProbe,
  MemberRule,
  MemberSubject,
} from "../domain/architecture-config.js";
import type { PatternInvalid } from "../domain/architecture-error.js";
import type { MemberSite } from "../domain/facts.js";
import type { Violation } from "../domain/violation.js";
import type { FactExtractor } from "../ports/fact-extractor.js";
import { compilePatterns, firstFromMatch } from "./patterns.js";

export type { MemberSite } from "../domain/facts.js";

export type CompiledMemberRule = {
  readonly name: string;
  readonly message: string;
  readonly from: ReadonlyArray<RegExp>;
  readonly fromNot: ReadonlyArray<RegExp>;
  readonly subject: MemberSubject;
  readonly in: ReadonlyArray<RegExp>;
  // Which declarations a `members` rule speaks to; `null` for every kind.
  readonly declares: ReadonlyArray<DeclarationKind> | null;
  readonly match: ReadonlyArray<RegExp>;
  readonly matchNot: ReadonlyArray<RegExp>;
  readonly allow: ReadonlyArray<RegExp>;
  readonly probe: MemberProbe;
};

export const compileMemberRule = (
  rule: MemberRule,
): Result.Result<CompiledMemberRule, PatternInvalid> => {
  const fields = [
    ["from", rule.from],
    ["fromNot", rule.fromNot],
    ["in", rule.in],
    ["match", rule.match],
    ["matchNot", rule.matchNot],
    ["allow", rule.allow],
  ] as const;

  const compiled: Array<ReadonlyArray<RegExp>> = [];

  for (const [field, patterns] of fields) {
    const one = compilePatterns(rule.name, field, patterns);

    if (Result.isFailure(one)) return Result.fail(one.failure);
    compiled.push(one.success);
  }

  const [from, fromNot, inside, match, matchNot, allow] = compiled as [
    ReadonlyArray<RegExp>,
    ReadonlyArray<RegExp>,
    ReadonlyArray<RegExp>,
    ReadonlyArray<RegExp>,
    ReadonlyArray<RegExp>,
    ReadonlyArray<RegExp>,
  ];

  return Result.succeed({
    name: rule.name,
    message: rule.message,
    probe: rule.probe,
    subject: rule.subject,
    from,
    fromNot,
    in: inside,
    declares: rule.declares === undefined ? null : [...rule.declares],
    match,
    matchNot,
    allow,
  });
};

export const compileMemberRules = (
  rules: ReadonlyArray<MemberRule>,
): Result.Result<ReadonlyArray<CompiledMemberRule>, PatternInvalid> => {
  const compiled: Array<CompiledMemberRule> = [];

  for (const rule of rules) {
    const one = compileMemberRule(rule);

    if (Result.isFailure(one)) return Result.fail(one.failure);
    compiled.push(one.success);
  }

  return Result.succeed(compiled);
};

const anyMatches = (patterns: ReadonlyArray<RegExp>, value: string): boolean =>
  patterns.some((pattern) => pattern.test(value));

export const memberRulesSelecting = (
  rules: ReadonlyArray<CompiledMemberRule>,
  file: string,
): ReadonlyArray<CompiledMemberRule> => rules.filter((rule) => firstFromMatch(rule, file) !== null);

const governs = (rule: CompiledMemberRule, site: MemberSite): boolean => {
  if (rule.subject !== site.subject) return false;

  if (rule.in.length > 0 && (site.in === undefined || !anyMatches(rule.in, site.in))) return false;

  if (
    rule.declares !== null &&
    (site.declares === undefined || !rule.declares.includes(site.declares))
  ) {
    return false;
  }

  if (rule.match.length > 0 && !anyMatches(rule.match, site.name)) return false;

  if (rule.matchNot.length > 0 && anyMatches(rule.matchNot, site.name)) return false;

  return true;
};

export const evaluateMemberSite = (
  selected: ReadonlyArray<CompiledMemberRule>,
  site: MemberSite,
): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = [];

  for (const rule of selected) {
    if (!governs(rule, site)) continue;

    if (anyMatches(rule.allow, site.name)) continue;

    violations.push({
      kind: "member",
      ruleName: rule.name,
      message: rule.message,
      file: site.file,
      subject: site.name,
    });
  }

  return violations;
};

// A probe with a `source` is checked through the parser: the snippet must
// yield a site named `probe.name` that the rule reports. That is the check a
// synthetic site cannot make — a rule about a declaration shape the extractor
// does not read passes its synthetic probe and reports nothing. A probe
// without a source is checked against the rule's patterns alone, as a site
// declared in the first kind the rule speaks to.
export const memberRulesFailingTheirProbe = (
  rules: ReadonlyArray<CompiledMemberRule>,
  extractor: FactExtractor,
): ReadonlyArray<CompiledMemberRule> =>
  rules.filter((rule) => {
    if (firstFromMatch(rule, rule.probe.from) === null) return true;

    const sites: ReadonlyArray<MemberSite> =
      rule.probe.source === undefined
        ? [
            {
              file: rule.probe.from,
              subject: rule.subject,
              name: rule.probe.name,
              ...(rule.probe.in === undefined ? {} : { in: rule.probe.in }),
              ...(rule.probe.declares === undefined
                ? rule.declares === null
                  ? {}
                  : { declares: rule.declares[0] }
                : { declares: rule.probe.declares }),
            },
          ]
        : extractor
            .factsOf(rule.probe.from, rule.probe.source)
            .memberSites.filter((site) => site.name === rule.probe.name);

    return !sites.some((site) => evaluateMemberSite([rule], site).length > 0);
  });
