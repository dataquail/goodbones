import type { View, ViewEdge, ViewEdgeStatus, ViewNode } from "@goodbones/core";
import { type Edge, MarkerType, type Node } from "@xyflow/react";
import type { CSSProperties } from "react";

import type { Selection } from "./hash-state.js";
import { selectionKey } from "./hash-state.js";
import type { Layout } from "./layout.js";

// The view, placed, as what React Flow draws. Pure: the app hands in a view,
// a layout and a selection and gets nodes and edges back, so the mapping is
// tested without a canvas.

export type CardData = {
  readonly view: ViewNode;
  readonly selected: boolean;
  // Whether an edge is selected and this node is at neither end of it.
  readonly dimmed: boolean;
  readonly [key: string]: unknown;
};

export type EdgeData = {
  readonly view: ViewEdge;
  readonly [key: string]: unknown;
};

export type FlowNode = Node<CardData, "card" | "folder">;
export type FlowEdge = Edge<EdgeData>;

// The three statuses `diagram` draws, and the ghost, in the same colours.
export const STATUS_COLOUR: Readonly<Record<ViewEdgeStatus, string>> = {
  admitted: "#5b6472",
  violation: "#c62828",
  ungoverned: "#f9a825",
  designed: "#9e9e9e",
};

export const edgeStyleOf = (edge: ViewEdge, selected: boolean): CSSProperties => ({
  stroke: STATUS_COLOUR[edge.status],
  strokeWidth: selected ? 3 : edge.status === "violation" ? 2.5 : Math.min(1 + edge.count / 4, 3),
  strokeDasharray:
    edge.status === "ungoverned" ? "6 4" : edge.status === "designed" ? "2 4" : undefined,
  opacity: edge.status === "designed" ? 0.8 : 1,
});

export const nodeKey = (id: string): string => selectionKey({ kind: "node", id });
export const edgeKey = (edge: Pick<ViewEdge, "from" | "to">): string =>
  selectionKey({ kind: "edge", from: edge.from, to: edge.to });

const isSelectedNode = (selection: Selection | null, id: string): boolean =>
  selection?.kind === "node" && selection.id === id;

const isSelectedEdge = (selection: Selection | null, edge: ViewEdge): boolean =>
  selection?.kind === "edge" && selection.from === edge.from && selection.to === edge.to;

export const flowOf = (
  view: View,
  layout: Layout,
  selection: Selection | null,
): { readonly nodes: ReadonlyArray<FlowNode>; readonly edges: ReadonlyArray<FlowEdge> } => {
  const endpoints = selection?.kind === "edge" ? new Set([selection.from, selection.to]) : null;

  const nodes: Array<FlowNode> = [];
  const place = (node: ViewNode, parentId: string | undefined): void => {
    const at = layout.placed.get(node.id);
    const children = node.children ?? [];
    nodes.push({
      id: node.id,
      type: children.length === 0 ? "card" : "folder",
      position: { x: at?.x ?? 0, y: at?.y ?? 0 },
      ...(at === undefined ? {} : { width: at.width, height: at.height }),
      ...(parentId === undefined ? {} : { parentId, extent: "parent" as const }),
      draggable: false,
      connectable: false,
      data: {
        view: node,
        selected: isSelectedNode(selection, node.id),
        dimmed: endpoints !== null && !endpoints.has(node.id),
      },
    });
    for (const child of children) place(child, node.id);
  };
  for (const member of view.members) place(member, undefined);
  for (const outside of view.outside) place(outside, undefined);

  const edges: Array<FlowEdge> = view.edges.map((edge) => {
    const selected = isSelectedEdge(selection, edge);
    return {
      id: edgeKey(edge),
      source: edge.from,
      target: edge.to,
      type: "default",
      ...(edge.count > 1 ? { label: String(edge.count) } : {}),
      ...(edge.status === "designed"
        ? { label: edge.count > 1 ? String(edge.count) : "designed" }
        : {}),
      style: edgeStyleOf(edge, selected),
      markerEnd: { type: MarkerType.ArrowClosed, color: STATUS_COLOUR[edge.status] },
      labelStyle: { fill: STATUS_COLOUR[edge.status], fontSize: 11 },
      labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
      selected,
      data: { view: edge },
    };
  });

  return { nodes, edges };
};
