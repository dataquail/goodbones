import type { View, ViewEdge, ViewNode } from "./view.js";

// A view as a mermaid flowchart: what a pull request comments and a document
// embeds. Nothing here that GitHub's renderer drops — no `click`, no
// `%%{init}%%` theme, no tooltip — and node ids are the paths themselves, so
// a diff of two renders is a diff of the architecture.

// A path as a mermaid identifier: letters, digits and underscores only, with
// a prefix so it never starts with a digit or collides with a keyword.
export const mermaidIdOf = (path: string): string => `n_${path.replace(/[^A-Za-z0-9]+/g, "_")}`;

// Mermaid reads `"` as the end of a label and `#` as an entity; both are
// written as entities. Everything else a path can hold is fine in quotes.
const escapeLabel = (label: string): string =>
  label.replaceAll("#", "#35;").replaceAll('"', "#quot;");

const labelOf = (node: ViewNode): string => {
  const badges = [
    ...(node.badges.violations > 0 ? [`⚠ ${String(node.badges.violations)}`] : []),
    ...(node.badges.cycles > 0 ? ["↻"] : []),
  ];
  return escapeLabel(badges.length === 0 ? node.label : `${node.label} ${badges.join(" ")}`);
};

// The arrow by status: solid for admitted, dotted for ungoverned, thick for a
// violation, dotted and labelled for an allowance nothing uses. The count is
// the label when there is more than one import beneath the edge.
const arrowOf = (edge: ViewEdge): string => {
  const count = edge.count > 1 ? String(edge.count) : "";
  switch (edge.status) {
    case "admitted":
      return count === "" ? "-->" : `-- ${count} -->`;
    case "ungoverned":
      return count === "" ? "-.->" : `-. ${count} .->`;
    case "violation":
      return count === "" ? "==>" : `== ${count} ==>`;
    case "designed":
      return "-. designed .->";
  }
};

const VIOLATION_STYLE = "stroke:#c62828,stroke-width:2px";
const DESIGNED_STYLE = "stroke:#9e9e9e";
const UNGOVERNED_STYLE = "stroke:#f9a825";

const declare = (node: ViewNode, indent: string): ReadonlyArray<string> => {
  if (node.children === undefined || node.children.length === 0) {
    return [`${indent}${mermaidIdOf(node.id)}["${labelOf(node)}"]`];
  }
  return [
    `${indent}subgraph ${mermaidIdOf(node.id)}["${labelOf(node)}"]`,
    ...node.children.flatMap((child) => declare(child, `${indent}  `)),
    `${indent}end`,
  ];
};

export const renderMermaid = (view: View): string => {
  const declarations = [...view.members, ...view.outside].flatMap((node) => declare(node, "  "));
  const arrows = view.edges.map(
    (edge) => `  ${mermaidIdOf(edge.from)} ${arrowOf(edge)} ${mermaidIdOf(edge.to)}`,
  );
  const styles = view.edges.flatMap((edge, index) => {
    const style =
      edge.status === "violation"
        ? VIOLATION_STYLE
        : edge.status === "designed"
          ? DESIGNED_STYLE
          : edge.status === "ungoverned"
            ? UNGOVERNED_STYLE
            : null;
    return style === null ? [] : [`  linkStyle ${String(index)} ${style}`];
  });
  const classes =
    view.outside.length === 0
      ? []
      : [
          "  classDef outside fill:none,stroke-dasharray:4 4,color:#666",
          `  class ${view.outside.map((one) => mermaidIdOf(one.id)).join(",")} outside`,
        ];
  return `${["flowchart TB", ...declarations, ...arrows, ...styles, ...classes].join("\n")}\n`;
};
