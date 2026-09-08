import type { Atlas, View, ViewNode } from "@goodbones/core";

import type { Selection } from "./hash-state.js";

// The manifest explaining itself on the canvas: a selected `reach` violation
// is a route through the tiers, a selected cycle is a component, and both are
// sets of files the view has rolled up to nodes. This maps the files to the
// units the view shows and the steps between them to the edges it draws, so
// the canvas can light them and dim the rest. Pure, like the view.

export type Highlight = {
  readonly label: string;
  readonly nodes: ReadonlySet<string>;
  // `${from}|${to}` of each view edge on the path or in the component.
  readonly edges: ReadonlySet<string>;
  // Files the view has no node for — outside a hidden edge, or not walked.
  readonly missing: ReadonlyArray<string>;
};

export const edgeId = (from: string, to: string): string => `${from}|${to}`;

const unitsOf = (view: View): ReadonlyArray<ViewNode> => [
  ...view.members.flatMap((member) =>
    member.children === undefined || member.children.length === 0 ? [member] : member.children,
  ),
  ...view.outside,
];

// The unit a file falls under: itself, or the nearest folder node holding it.
const unitFor = (units: ReadonlyArray<ViewNode>, file: string): string | null => {
  let best: ViewNode | null = null;
  for (const unit of units) {
    const holds =
      unit.kind === "file" || unit.kind === "package" || unit.kind === "builtin"
        ? unit.id === file
        : file === unit.id || file.startsWith(`${unit.id}/`);
    if (holds && (best === null || unit.id.length > best.id.length)) best = unit;
  }
  return best?.id ?? null;
};

const over = (
  view: View,
  files: ReadonlyArray<string>,
  steps: ReadonlyArray<readonly [string, string]>,
  label: string,
): Highlight => {
  const units = unitsOf(view);
  const drawn = new Set(view.edges.map((edge) => edgeId(edge.from, edge.to)));
  const nodes = new Set<string>();
  const missing: Array<string> = [];
  const unitOf = new Map<string, string | null>();
  for (const file of files) {
    const unit = unitFor(units, file);
    unitOf.set(file, unit);
    if (unit === null) missing.push(file);
    else nodes.add(unit);
  }
  const edges = new Set<string>();
  for (const [from, to] of steps) {
    const a = unitOf.get(from) ?? null;
    const b = unitOf.get(to) ?? null;
    if (a === null || b === null || a === b) continue;
    const id = edgeId(a, b);
    if (drawn.has(id)) edges.add(id);
  }
  return { label, nodes, edges, missing };
};

export const highlightOf = (
  atlas: Atlas,
  view: View,
  selection: Selection | null,
): Highlight | null => {
  if (selection === null) return null;
  if (selection.kind === "violation") {
    const violation = atlas.violations.find((one) => one.fingerprint === selection.fingerprint);
    if (violation === undefined) return null;
    const route = violation.route ?? [];
    if (route.length === 0) {
      const files = [violation.file, ...(violation.subject === null ? [] : [violation.subject])];
      const steps: ReadonlyArray<readonly [string, string]> =
        violation.kind === "import" && violation.subject !== null
          ? [[violation.file, violation.subject]]
          : [];
      return over(view, files, steps, violation.ruleName);
    }
    const steps = route.slice(1).map((to, index) => [route[index] ?? "", to] as const);
    return over(view, route, steps, `${violation.ruleName}: ${String(route.length - 1)} hops`);
  }
  if (selection.kind === "cycle") {
    const members = atlas.cycles[selection.index];
    if (members === undefined) return null;
    const within = new Set(members);
    const steps = atlas.edges
      .filter((edge) => within.has(edge.from) && within.has(edge.to))
      .map((edge) => [edge.from, edge.to] as const);
    return over(view, members, steps, `cycle of ${String(members.length)} files`);
  }
  return null;
};
