import * as Result from "effect/Result";

import type {
  GraphConfig,
  GraphCycleRule,
  GraphOrphanRule,
  GraphProbe,
  GraphReachRule,
} from "../domain/architecture-config.js";
import type { PatternInvalid } from "../domain/architecture-error.js";
import type { Violation } from "../domain/violation.js";
import { compilePatterns } from "./patterns.js";

// The import graph, as facts: every file the policy walked, and for each the
// files it resolves to. Externals and builtins are not nodes — a rule about
// the shape of the repository is about the repository's own files.
export type Graph = {
  readonly files: ReadonlyArray<string>;
  readonly edges: ReadonlyMap<string, ReadonlyArray<string>>;
};

export type CompiledGraphCycleRule = {
  readonly name: string;
  readonly message: string;
  readonly within: ReadonlyArray<RegExp>;
  readonly withinNot: ReadonlyArray<RegExp>;
  readonly probe: GraphProbe;
};

export type CompiledGraphOrphanRule = CompiledGraphCycleRule & {
  readonly entry: ReadonlyArray<RegExp>;
};

export type CompiledGraphReachRule = {
  readonly name: string;
  readonly message: string;
  readonly from: ReadonlyArray<RegExp>;
  readonly fromNot: ReadonlyArray<RegExp>;
  readonly to: ReadonlyArray<RegExp>;
  readonly toNot: ReadonlyArray<RegExp>;
  readonly via: ReadonlyArray<RegExp>;
  readonly probe: GraphProbe;
};

export type CompiledGraph = {
  readonly cycles: ReadonlyArray<CompiledGraphCycleRule>;
  readonly orphans: ReadonlyArray<CompiledGraphOrphanRule>;
  readonly reach: ReadonlyArray<CompiledGraphReachRule>;
};

export const EMPTY_GRAPH_RULES: CompiledGraph = { cycles: [], orphans: [], reach: [] };

export const hasGraphRules = (rules: CompiledGraph): boolean =>
  rules.cycles.length + rules.orphans.length + rules.reach.length > 0;

type Fields = ReadonlyArray<readonly [string, string | ReadonlyArray<string> | undefined]>;

const compileFields = (
  ruleName: string,
  fields: Fields,
): Result.Result<ReadonlyArray<ReadonlyArray<RegExp>>, PatternInvalid> => {
  const compiled: Array<ReadonlyArray<RegExp>> = [];
  for (const [field, patterns] of fields) {
    const one = compilePatterns(ruleName, field, patterns);
    if (Result.isFailure(one)) return Result.fail(one.failure);
    compiled.push(one.success);
  }
  return Result.succeed(compiled);
};

const compileCycle = (
  rule: GraphCycleRule,
): Result.Result<CompiledGraphCycleRule, PatternInvalid> => {
  const fields = compileFields(rule.name, [
    ["within", rule.within],
    ["withinNot", rule.withinNot],
  ]);
  if (Result.isFailure(fields)) return Result.fail(fields.failure);
  const [within = [], withinNot = []] = fields.success;
  return Result.succeed({
    name: rule.name,
    message: rule.message,
    probe: rule.probe,
    within,
    withinNot,
  });
};

const compileOrphan = (
  rule: GraphOrphanRule,
): Result.Result<CompiledGraphOrphanRule, PatternInvalid> => {
  const fields = compileFields(rule.name, [
    ["within", rule.within],
    ["withinNot", rule.withinNot],
    ["entry", rule.entry],
  ]);
  if (Result.isFailure(fields)) return Result.fail(fields.failure);
  const [within = [], withinNot = [], entry = []] = fields.success;
  return Result.succeed({
    name: rule.name,
    message: rule.message,
    probe: rule.probe,
    within,
    withinNot,
    entry,
  });
};

const compileReach = (
  rule: GraphReachRule,
): Result.Result<CompiledGraphReachRule, PatternInvalid> => {
  const fields = compileFields(rule.name, [
    ["from", rule.from],
    ["fromNot", rule.fromNot],
    ["to", rule.to],
    ["toNot", rule.toNot],
    ["via", rule.via],
  ]);
  if (Result.isFailure(fields)) return Result.fail(fields.failure);
  const [from = [], fromNot = [], to = [], toNot = [], via = []] = fields.success;
  return Result.succeed({
    name: rule.name,
    message: rule.message,
    probe: rule.probe,
    from,
    fromNot,
    to,
    toNot,
    via,
  });
};

export const compileGraphRules = (
  config: GraphConfig | undefined,
): Result.Result<CompiledGraph, PatternInvalid> => {
  const cycles: Array<CompiledGraphCycleRule> = [];
  for (const rule of config?.cycles ?? []) {
    const one = compileCycle(rule);
    if (Result.isFailure(one)) return Result.fail(one.failure);
    cycles.push(one.success);
  }
  const orphans: Array<CompiledGraphOrphanRule> = [];
  for (const rule of config?.orphans ?? []) {
    const one = compileOrphan(rule);
    if (Result.isFailure(one)) return Result.fail(one.failure);
    orphans.push(one.success);
  }
  const reach: Array<CompiledGraphReachRule> = [];
  for (const rule of config?.reach ?? []) {
    const one = compileReach(rule);
    if (Result.isFailure(one)) return Result.fail(one.failure);
    reach.push(one.success);
  }
  return Result.succeed({ cycles, orphans, reach });
};

const anyMatches = (patterns: ReadonlyArray<RegExp>, value: string): boolean =>
  patterns.some((pattern) => pattern.test(value));

const inScope = (
  scope: { readonly within: ReadonlyArray<RegExp>; readonly withinNot: ReadonlyArray<RegExp> },
  file: string,
): boolean => anyMatches(scope.within, file) && !anyMatches(scope.withinNot, file);

// Sorted adjacency, so every traversal below is deterministic and a subject
// rendered from it is the same on every run.
const neighboursOf = (graph: Graph, file: string): ReadonlyArray<string> =>
  [...(graph.edges.get(file) ?? [])].sort();

// Tarjan's strongly connected components over the subgraph a rule is about.
// A component of one node is a cycle only if that node imports itself.
const stronglyConnected = (
  nodes: ReadonlyArray<string>,
  graph: Graph,
): ReadonlyArray<ReadonlyArray<string>> => {
  const members = new Set(nodes);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: Array<string> = [];
  const components: Array<ReadonlyArray<string>> = [];
  let next = 0;

  const visit = (node: string): void => {
    index.set(node, next);
    low.set(node, next);
    next += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of neighboursOf(graph, node)) {
      if (!members.has(target)) continue;
      if (!index.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(target) ?? 0));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(target) ?? 0));
      }
    }

    if (low.get(node) === index.get(node)) {
      const component: Array<string> = [];
      let popped: string | undefined;
      do {
        popped = stack.pop();
        if (popped === undefined) break;
        onStack.delete(popped);
        component.push(popped);
      } while (popped !== node);
      components.push(component.sort());
    }
  };

  for (const node of [...nodes].sort()) if (!index.has(node)) visit(node);
  return components;
};

// Every cycle in the graph, each as its sorted member set. What `infer` asks
// before it writes a no-cycles rule: a rule the tree fails on day one is a
// baseline entry, not a description of the tree.
export const cyclesIn = (graph: Graph): ReadonlyArray<ReadonlyArray<string>> =>
  stronglyConnected(graph.files, graph).filter((component) => {
    const [first] = component;
    return (
      first !== undefined &&
      (component.length > 1 || (graph.edges.get(first) ?? []).includes(first))
    );
  });

// How far each file stands above a leaf: 0 for a file importing nothing the
// walk saw, else one more than the tallest thing it imports. A violation on a
// short target is local to fix; one on a tall target drags the tower with it —
// so a report lists the short ones first. Measured over the strongly
// connected components, so the members of a cycle share one height and the
// answer is finite: a cycle is one thing to fix, not a ladder.
export const heightOf = (graph: Graph): ReadonlyMap<string, number> => {
  const components = stronglyConnected(graph.files, graph);
  const componentOf = new Map<string, number>();
  components.forEach((component, index) => {
    for (const file of component) componentOf.set(file, index);
  });

  const heights = new Map<number, number>();
  const measure = (index: number): number => {
    const known = heights.get(index);
    if (known !== undefined) return known;
    let tallest = -1;
    for (const file of components[index] ?? []) {
      for (const target of neighboursOf(graph, file)) {
        const other = componentOf.get(target);
        if (other !== undefined && other !== index) tallest = Math.max(tallest, measure(other));
      }
    }
    heights.set(index, tallest + 1);
    return tallest + 1;
  };

  const byFile = new Map<string, number>();
  for (const file of [...graph.files].sort()) {
    const index = componentOf.get(file);
    if (index !== undefined) byFile.set(file, measure(index));
  }
  return byFile;
};

const evaluateCycles = (rule: CompiledGraphCycleRule, graph: Graph): ReadonlyArray<Violation> => {
  const nodes = graph.files.filter((file) => inScope(rule, file));
  const violations: Array<Violation> = [];
  for (const component of stronglyConnected(nodes, graph)) {
    const [first] = component;
    if (first === undefined) continue;
    const isCycle = component.length > 1 || (graph.edges.get(first) ?? []).includes(first);
    if (!isCycle) continue;
    // The subject is the component as a set, so the entry survives an edge
    // added or removed elsewhere in the same cycle.
    violations.push({
      kind: "graph",
      ruleName: rule.name,
      message: rule.message,
      file: first,
      subject: component.join(" ↔ "),
    });
  }
  return violations;
};

const evaluateOrphans = (rule: CompiledGraphOrphanRule, graph: Graph): ReadonlyArray<Violation> => {
  const imported = new Set<string>();
  for (const targets of graph.edges.values()) for (const target of targets) imported.add(target);

  return graph.files
    .filter((file) => inScope(rule, file) && !anyMatches(rule.entry, file) && !imported.has(file))
    .map((file) => ({
      kind: "graph",
      ruleName: rule.name,
      message: rule.message,
      file,
      subject: null,
    }));
};

// Breadth-first from each `from` file, never stepping onto a `via` node, so a
// `to` reached is one reached without passing through the tier that was
// supposed to mediate. The route is put in the message, not the subject: the
// fingerprint is (from, to), which survives the route changing.
const evaluateReach = (rule: CompiledGraphReachRule, graph: Graph): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = [];
  const isTarget = (file: string) => anyMatches(rule.to, file) && !anyMatches(rule.toNot, file);

  for (const origin of graph.files) {
    if (!anyMatches(rule.from, origin) || anyMatches(rule.fromNot, origin)) continue;

    const parent = new Map<string, string>();
    const queue: Array<string> = [origin];
    const seen = new Set<string>([origin]);
    const reported = new Set<string>();

    while (queue.length > 0) {
      const node = queue.shift();
      if (node === undefined) break;
      for (const target of neighboursOf(graph, node)) {
        if (seen.has(target)) continue;
        if (anyMatches(rule.via, target)) continue;
        seen.add(target);
        parent.set(target, node);
        if (isTarget(target) && !reported.has(target)) {
          reported.add(target);
          const route: Array<string> = [target];
          let step: string | undefined = target;
          while (step !== undefined && step !== origin) {
            step = parent.get(step);
            if (step !== undefined) route.unshift(step);
          }
          violations.push({
            kind: "graph",
            ruleName: rule.name,
            message: `${rule.message} (route: ${route.join(" → ")})`,
            file: origin,
            subject: target,
          });
        }
        queue.push(target);
      }
    }
  }
  return violations;
};

export const evaluateGraph = (rules: CompiledGraph, graph: Graph): ReadonlyArray<Violation> => [
  ...rules.cycles.flatMap((rule) => evaluateCycles(rule, graph)),
  ...rules.orphans.flatMap((rule) => evaluateOrphans(rule, graph)),
  ...rules.reach.flatMap((rule) => evaluateReach(rule, graph)),
];

// A probe is a small synthetic graph the rule must report on.
export const graphOf = (probe: GraphProbe): Graph => {
  const edges = new Map<string, Array<string>>();
  const files = new Set<string>(probe.files ?? []);
  for (const [from, to] of probe.edges) {
    files.add(from);
    files.add(to);
    const targets = edges.get(from) ?? [];
    targets.push(to);
    edges.set(from, targets);
  }
  return { files: [...files].sort(), edges };
};

export const graphRulesFailingTheirProbe = (rules: CompiledGraph): ReadonlyArray<string> => [
  ...rules.cycles
    .filter((rule) => evaluateCycles(rule, graphOf(rule.probe)).length === 0)
    .map((rule) => rule.name),
  ...rules.orphans
    .filter((rule) => evaluateOrphans(rule, graphOf(rule.probe)).length === 0)
    .map((rule) => rule.name),
  ...rules.reach
    .filter((rule) => evaluateReach(rule, graphOf(rule.probe)).length === 0)
    .map((rule) => rule.name),
];
