import { Handle, type NodeProps, Position } from "@xyflow/react";
import type { ReactElement } from "react";

import type { FlowNode } from "./flow.js";

// One node of the canvas: a folder, a file, or something outside the focus.
// The label, the count of files beneath, and the badges the view computed —
// this component draws and decides nothing.

const KIND_LABEL: Readonly<Record<FlowNode["data"]["view"]["kind"], string>> = {
  folder: "folder",
  file: "file",
  outside: "outside",
  package: "package",
  builtin: "builtin",
};

export const Badges = ({ node }: { readonly node: FlowNode["data"]["view"] }): ReactElement => (
  <span className="badges">
    {node.badges.violations > 0 && (
      <span className="badge violation" title="violations the baseline does not carry">
        ⚠ {node.badges.violations}
      </span>
    )}
    {node.badges.baselined > 0 && (
      <span className="badge baselined" title="violations the baseline carries">
        {node.badges.baselined} baselined
      </span>
    )}
    {node.badges.cycles > 0 && (
      <span className="badge cycle" title="a cycle runs through here">
        ↻
      </span>
    )}
    {node.badges.unrestricted && (
      <span className="badge adoption" title="this tier states no allowlist yet">
        unrestricted
      </span>
    )}
    {node.badges.partial && (
      <span className="badge adoption" title="this folder does not enumerate its files">
        partial
      </span>
    )}
  </span>
);

const classNames = (props: NodeProps<FlowNode>): string =>
  [
    "card",
    props.data.view.kind,
    props.data.selected ? "is-selected" : "",
    props.data.dimmed ? "is-dimmed" : "",
    props.data.view.residue > 0 && props.data.view.residue === props.data.view.files
      ? "is-residue"
      : "",
  ]
    .filter((one) => one !== "")
    .join(" ");

export const NodeCard = (props: NodeProps<FlowNode>): ReactElement => {
  const node = props.data.view;
  return (
    <div className={classNames(props)} title={node.message ?? node.id}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="card-head">
        <span className="kind">{KIND_LABEL[node.kind]}</span>
        <Badges node={node} />
      </div>
      <div className="label">{node.label}</div>
      {node.kind !== "file" && node.kind !== "package" && node.kind !== "builtin" && (
        <div className="meta">
          {node.files} {node.files === 1 ? "file" : "files"}
          {node.residue > 0 ? ` · ${String(node.residue)} residue` : ""}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
};

// A folder shown with its children inside, at depth 2: a header over the
// area the children are placed in.
export const FolderGroup = (props: NodeProps<FlowNode>): ReactElement => {
  const node = props.data.view;
  return (
    <div className={`${classNames(props)} group`} title={node.message ?? node.id}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="group-head">
        <span className="label">{node.label}</span>
        <Badges node={node} />
        <span className="meta">
          {node.files} {node.files === 1 ? "file" : "files"}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
};
