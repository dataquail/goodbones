import type { Allowance } from "../domain/architecture-config.js";
import type { ResolvedTarget } from "../ports/module-resolver.js";
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
// minus the compiled pattern nobody wrote.
export type Slack = Pick<Allowance, "node" | "kind" | "entry">;

const keyOf = (one: Slack): string => `${one.node} ${one.kind} ${one.entry}`;

// Whether one edge, from a file this rule selects, passes through this entry.
const uses = (allowance: Allowance, captures: RegExpExecArray, target: ResolvedTarget): boolean => {
  if (allowance.kind === "external") {
    return target.kind === "external" && target.package === allowance.entry;
  }
  return allowance.pattern !== undefined && matchesAny([allowance.pattern], captures, target.path);
};

// Every allowance the rules carry that no edge uses, in the order the manifest
// declared them. An entry is inherited by every descendant's rule and written
// once, so it is keyed by where it was written: an import anywhere under the
// declaring node is a use.
export const slackOf = (
  rules: ReadonlyArray<CompiledImportRule>,
  edges: ReadonlyArray<ObservedEdge>,
): ReadonlyArray<Slack> => {
  const declared = new Map<string, Slack>();
  for (const rule of rules) {
    for (const { entry, kind, node } of rule.allowances) {
      const one = { node, kind, entry };
      if (!declared.has(keyOf(one))) declared.set(keyOf(one), one);
    }
  }

  const used = new Set<string>();
  for (const edge of edges) {
    for (const rule of rules) {
      if (rule.allowances.length === 0) continue;
      const captures = firstFromMatch(rule, edge.importer);
      if (captures === null) continue;
      for (const allowance of rule.allowances) {
        if (uses(allowance, captures, edge.target)) used.add(keyOf(allowance));
      }
    }
  }

  return [...declared.values()].filter((one) => !used.has(keyOf(one)));
};
