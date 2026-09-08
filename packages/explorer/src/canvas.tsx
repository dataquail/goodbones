import "@xyflow/react/dist/style.css";

import type { View, ViewEdge, ViewNode } from "@goodbones/core";
import {
  Background,
  Controls,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import { type ReactElement, useMemo } from "react";

import { type FlowEdge, type FlowNode, flowOf } from "./flow.js";
import type { Selection } from "./hash-state.js";
import type { Highlight } from "./highlight.js";
import type { Layout } from "./layout.js";
import { FolderGroup, NodeCard } from "./node-card.js";

export type CanvasProps = {
  readonly view: View;
  readonly layout: Layout;
  readonly selection: Selection | null;
  readonly highlight: Highlight | null;
  // A folder clicked becomes the focus; a file or an outside node is selected.
  readonly onNode: (node: ViewNode) => void;
  readonly onEdge: (edge: ViewEdge) => void;
  readonly onClear: () => void;
};

const NODE_TYPES = { card: NodeCard, folder: FolderGroup };

export const Canvas = (props: CanvasProps): ReactElement => {
  const { edges, nodes } = useMemo(
    () => flowOf(props.view, props.layout, props.selection, props.highlight),
    [props.view, props.layout, props.selection, props.highlight],
  );
  const onNodeClick: NodeMouseHandler<FlowNode> = (_event, node) => {
    props.onNode(node.data.view);
  };
  const onEdgeClick: EdgeMouseHandler<FlowEdge> = (_event, edge) => {
    if (edge.data !== undefined) props.onEdge(edge.data.view);
  };
  return (
    <ReactFlowProvider>
      <ReactFlow
        // Remounting on a new focus is what re-fits the viewport to it.
        key={`${props.view.focus}/${String(props.view.members.length)}`}
        nodes={nodes as Array<FlowNode>}
        edges={edges as Array<FlowEdge>}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1.25 }}
        minZoom={0.1}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={props.onClear}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </ReactFlowProvider>
  );
};
