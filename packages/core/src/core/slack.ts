import type { Allowance } from "../domain/architecture-config.js";
import type { ResolvedTarget } from "../ports/module-resolver.js";
import { vacantNodesOf } from "./coverage.js";
import type { CompiledImportRule } from "./imports.js";
import { firstFromMatch, matchesAny } from "./patterns.js";

// Coverage says how many files an allowlist reaches. This is the other
// question about an allowlist: how much of it is used. A manifest inferred
// from today's edges reaches every file and constrains nothing, so coverage
// alone reads as complete while the policy is pure permission; slack is the
// number that tells the two apart. It is also the signature of an allowlist
// widened to make a build green — an entry nothing imports through.

// An edge the host resolved: the importer, and what the specifier became.
export type ObservedEdge = {
  readonly importer: string;
  readonly target: ResolvedTarget;
};

// An allowance no observed edge uses. The same shape the lowering recorded,
// minus the compiled pattern nobody wrote. When the entry arrived through
// `use`, `node` is the fragment's name — the line to delete is in `defs` —
// and `of` says how many nodes wrote the reference that carried it.
export type Slack = Pick<Allowance, "node" | "kind" | "entry"> & {
  readonly fragment?: string;
  readonly of?: number;
};

// A fragment entry used at some of the nodes it was granted to and not the
// rest. At the fragment level it is not slack — there is no line nobody
// needs — but it is a per-file permission written as a many-node allowance,
// which is what an allowlist widened to make one build green looks like.
export type Concentration = Pick<Allowance, "kind" | "entry"> & {
  readonly fragment: string;
  readonly usedAt: number;
  readonly of: number;
};

export type SlackReport = {
  readonly slack: ReadonlyArray<Slack>;
  readonly concentration: ReadonlyArray<Concentration>;
};

const keyOf = (one: Pick<Allowance, "node" | "kind" | "entry">): string =>
  `${one.node} ${one.kind} ${one.entry}`;

// Whether one edge, from a file this rule selects, passes through this entry.
const uses = (allowance: Allowance, captures: RegExpExecArray, target: ResolvedTarget): boolean => {
  if (allowance.kind === "external") {
    return target.kind === "external" && target.package === allowance.entry;
  }
  return allowance.pattern !== undefined && matchesAny([allowance.pattern], captures, target.path);
};

// Every allowance an observed edge passes through: each entry, on each
// allowlist rule that selects the importer, that matches the target. The one
// matcher `slackOf` counts with and `admittedBy` answers from, so the two
// never disagree about what "used" means. Ancestors' entries come before the
// node's own, as the allowlist accumulated them.
export const allowancesAdmitting = (
  rules: ReadonlyArray<CompiledImportRule>,
  edge: ObservedEdge,
): ReadonlyArray<Allowance> => {
  const admitting: Array<Allowance> = [];
  for (const rule of rules) {
    if (rule.allowances.length === 0) continue;
    const captures = firstFromMatch(rule, edge.importer);
    if (captures === null) continue;
    for (const allowance of rule.allowances) {
      if (uses(allowance, captures, edge.target)) admitting.push(allowance);
    }
  }
  return admitting;
};

// The allowance that admitted an observed edge, or null when none did — the
// edge is then a violation, or from a file under no allowlist. When several
// admit it, the one written nearest the importer: the most specific sentence
// about why the edge is allowed.
export const admittedBy = (
  rules: ReadonlyArray<CompiledImportRule>,
  edge: ObservedEdge,
): Allowance | null => allowancesAdmitting(rules, edge).at(-1) ?? null;

// One entry as one place wrote it: a node that wrote the line, or a fragment
// that N nodes pulled in with `use`. Keyed by that place, so a fragment's
// entry is reported once however many nodes reference it.
type Declared = {
  readonly node: string;
  readonly kind: Allowance["kind"];
  readonly entry: string;
  readonly fragment: string | undefined;
  // The nodes that declared it, vacant ones excluded — every allowance on a
  // vacant node is unused by construction, and is vacancy, not slack.
  readonly at: Set<string>;
};

const groupKeyOf = (one: Allowance): string =>
  one.fragment === undefined
    ? `node ${one.node} ${one.kind} ${one.entry}`
    : `use ${one.fragment} ${one.kind} ${one.entry}`;

// Every allowance the rules carry that no edge uses, in the order the manifest
// declared them. An entry is inherited by every descendant's rule and written
// once, so it is keyed by where it was written: an import anywhere under the
// declaring node is a use. An entry that arrived through `use` is keyed by
// the fragment, and is slack only when no node it was granted to uses it;
// used at some and not others, it is reported as concentration instead. A
// vacant node — one whose allowlist selects no walked file — contributes
// nothing to either.
export const slackOf = (
  rules: ReadonlyArray<CompiledImportRule>,
  edges: ReadonlyArray<ObservedEdge>,
  files: ReadonlyArray<string>,
): SlackReport => {
  const vacant = vacantNodesOf(rules, files);

  const declared = new Map<string, Declared>();
  for (const rule of rules) {
    for (const allowance of rule.allowances) {
      if (vacant.has(allowance.node)) continue;
      const key = groupKeyOf(allowance);
      const group = declared.get(key) ?? {
        node: allowance.fragment ?? allowance.node,
        kind: allowance.kind,
        entry: allowance.entry,
        fragment: allowance.fragment,
        at: new Set<string>(),
      };
      group.at.add(allowance.node);
      declared.set(key, group);
    }
  }

  // Which (node, kind, entry) some edge passes through.
  const used = new Set<string>();
  for (const edge of edges) {
    for (const allowance of allowancesAdmitting(rules, edge)) used.add(keyOf(allowance));
  }

  const slack: Array<Slack> = [];
  const concentration: Array<Concentration> = [];
  for (const group of declared.values()) {
    const { entry, kind } = group;
    const usedAt = [...group.at].filter((node) => used.has(keyOf({ node, kind, entry }))).length;
    if (group.fragment === undefined) {
      if (usedAt === 0) slack.push({ node: group.node, kind, entry });
      continue;
    }
    const of = group.at.size;
    if (usedAt === 0) {
      slack.push({ node: group.node, kind, entry, fragment: group.fragment, of });
    } else if (usedAt < of) {
      concentration.push({ fragment: group.fragment, kind, entry, usedAt, of });
    }
  }
  return { slack, concentration };
};
