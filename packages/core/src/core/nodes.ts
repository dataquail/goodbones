import type { LoweredNode } from "../domain/architecture-config.js";

// A rule says what fired; a node says what tier a file is in. Lowering keeps
// the tree's nodes with the pattern that selects each one's files, and this is
// the question asked of them: given a file, which nodes govern it, deepest
// first. The deepest is the one whose sentence a reader should be shown.

const selectorCache = new Map<string, RegExp>();

const selectorOf = (node: LoweredNode): RegExp => {
  const cached = selectorCache.get(node.selector);
  if (cached !== undefined) return cached;
  const compiled = new RegExp(node.selector);
  selectorCache.set(node.selector, compiled);
  return compiled;
};

// How far below the tree's top a node sits.
const depthOf = (node: LoweredNode, byName: ReadonlyMap<string, LoweredNode>): number => {
  let depth = 0;
  let at: LoweredNode | undefined = node;
  while (at?.parent !== null && at !== undefined) {
    depth += 1;
    at = byName.get(at.parent);
  }
  return depth;
};

// The nodes whose selector matches the file, deepest first; ties keep manifest
// order. A file key's node is deeper than its folder's, so a file governed by
// both is answered with the file's.
export const nodesSelecting = (
  nodes: ReadonlyArray<LoweredNode>,
  file: string,
): ReadonlyArray<LoweredNode> => {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  return nodes
    .map((node, index) => ({ node, index, depth: depthOf(node, byName) }))
    .filter(({ node }) => selectorOf(node).test(file))
    .sort((a, b) => (a.depth === b.depth ? a.index - b.index : b.depth - a.depth))
    .map(({ node }) => node);
};

// The deepest node governing the file, or null when the tree does not reach it.
export const governingNode = (
  nodes: ReadonlyArray<LoweredNode>,
  file: string,
): LoweredNode | null => nodesSelecting(nodes, file)[0] ?? null;
