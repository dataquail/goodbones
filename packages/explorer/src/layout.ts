import type { View, ViewNode } from "@goodbones/core";
import * as bundled from "elkjs/lib/elk.bundled.js";
import type { ELK, ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";

// Layout is the viewer's job, and ELK's. The layered algorithm ranks nodes by
// the edges between them and breaks cycles to do it, so the result reads
// top-down as the topological order the manifest's allowances imply — the
// layer diagram, with no hint key on any node. The view carries no
// coordinates; this is where they come from, per view.

export type Placed = {
  readonly id: string;
  // Relative to the parent's origin for a nested node, else to the canvas.
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type Layout = {
  readonly placed: ReadonlyMap<string, Placed>;
  readonly width: number;
  readonly height: number;
};

export type LayoutEngine = (view: View) => Promise<Layout>;

const CHARACTER = 7.5;
const PADDING = 32;
export const NODE_HEIGHT = 56;
const GROUP_HEADER = 36;
const GROUP_PADDING = 16;

// Wide enough for the label and the badges beside it.
export const sizeOf = (node: ViewNode): { readonly width: number; readonly height: number } => {
  const badges = (node.badges.violations > 0 ? 4 : 0) + (node.badges.cycles > 0 ? 2 : 0);
  return {
    width: Math.max(120, Math.round((node.label.length + badges) * CHARACTER + PADDING)),
    height: NODE_HEIGHT,
  };
};

const LAYERED = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.spacing.nodeNode": "40",
  "elk.layered.spacing.nodeNodeBetweenLayers": "72",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.edgeRouting": "SPLINES",
};

const elkNodeOf = (node: ViewNode): ElkNode => {
  const size = sizeOf(node);
  if (node.children === undefined || node.children.length === 0) {
    return { id: node.id, width: size.width, height: size.height };
  }
  return {
    id: node.id,
    layoutOptions: {
      ...LAYERED,
      "elk.padding": `[top=${String(GROUP_HEADER + GROUP_PADDING)},left=${String(GROUP_PADDING)},bottom=${String(GROUP_PADDING)},right=${String(GROUP_PADDING)}]`,
    },
    children: node.children.map(elkNodeOf),
  };
};

const collect = (nodes: ReadonlyArray<ElkNode>, into: Map<string, Placed>): void => {
  for (const node of nodes) {
    into.set(node.id, {
      id: node.id,
      x: node.x ?? 0,
      y: node.y ?? 0,
      width: node.width ?? 0,
      height: node.height ?? 0,
    });
    if (node.children !== undefined) collect(node.children, into);
  }
};

// The bundle is CommonJS: its one export is the constructor, reached as the
// module's default under Node's rules and Vite's alike. Named here once, since
// the type-aware linter cannot see through the CommonJS namespace.
const ElkConstructor = (bundled as unknown as { readonly default: new () => ELK }).default;
const elk: ELK = new ElkConstructor();

export const elkLayout: LayoutEngine = async (view) => {
  const edges: Array<ElkExtendedEdge> = view.edges.map((edge) => ({
    id: `${edge.from}|${edge.to}`,
    sources: [edge.from],
    targets: [edge.to],
  }));
  const graph: ElkNode = {
    id: "root",
    layoutOptions: { ...LAYERED, "elk.hierarchyHandling": "INCLUDE_CHILDREN" },
    children: [...view.members, ...view.outside].map(elkNodeOf),
    edges,
  };
  const laid = await elk.layout(graph);
  const placed = new Map<string, Placed>();
  collect(laid.children ?? [], placed);
  return { placed, width: laid.width ?? 0, height: laid.height ?? 0 };
};

// A grid, for a test or a canvas with no engine: one row of members, one of
// the outside, children stacked inside their parent.
export const gridLayout: LayoutEngine = (view) => {
  const placed = new Map<string, Placed>();
  let width = 0;
  const row = (nodes: ReadonlyArray<ViewNode>, y: number): number => {
    let x = 0;
    let tallest = NODE_HEIGHT;
    for (const node of nodes) {
      const size = sizeOf(node);
      const children = node.children ?? [];
      const height =
        children.length === 0
          ? size.height
          : GROUP_HEADER + GROUP_PADDING * 2 + children.length * (NODE_HEIGHT + GROUP_PADDING);
      const innerWidth =
        children.length === 0 ? size.width : Math.max(...children.map((one) => sizeOf(one).width));
      const nodeWidth = children.length === 0 ? size.width : innerWidth + GROUP_PADDING * 2;
      placed.set(node.id, { id: node.id, x, y, width: nodeWidth, height });
      children.forEach((child, index) => {
        placed.set(child.id, {
          id: child.id,
          x: GROUP_PADDING,
          y: GROUP_HEADER + GROUP_PADDING + index * (NODE_HEIGHT + GROUP_PADDING),
          width: sizeOf(child).width,
          height: NODE_HEIGHT,
        });
      });
      x += nodeWidth + 40;
      tallest = Math.max(tallest, height);
    }
    width = Math.max(width, x);
    return y + tallest + 72;
  };
  const after = row(view.members, 0);
  const bottom = row(view.outside, after);
  return Promise.resolve({ placed, width, height: bottom });
};
