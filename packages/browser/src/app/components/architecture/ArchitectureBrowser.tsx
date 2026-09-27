import { useEffect, useMemo, useState } from "react";

import type { Atlas, AtlasNode, AtlasPosition } from "../../../model/atlas.js";
import { Detail } from "./Detail.js";
import { ManifestPane } from "./ManifestPane.js";
import { arcsOf, foldersRevealing, initiallyExpanded, relationsOf, rowsOf } from "./rows.js";
import type { Selection } from "./selection.js";
import { Tree } from "./Tree.js";

// The Architecture Browser: the tree on the left with every edge drawn beside
// it, the manifest on the right, and what the two say about the thing under
// the pointer between them. Hover a file and its edges come forward, its
// governing node lights up in the manifest; hover a node and the files it
// governs light up in the tree. Click to keep either.

const selectionOf = (atlas: Atlas, text: string | null): Selection | null => {
  if (text === null) return null;
  if (text.startsWith("node:")) return { kind: "node", id: text.slice(5) };
  if (atlas.files.some((file) => file.path === text)) return { kind: "file", path: text };
  if (atlas.folders.some((folder) => folder.path === text)) return { kind: "folder", path: text };
  return null;
};

const textOf = (selection: Selection | null): string | null =>
  selection === null ? null : selection.kind === "node" ? `node:${selection.id}` : selection.path;

type Props = {
  readonly atlas: Atlas;
  readonly selection: string | null;
  readonly onSelect: (selection: string | null) => void;
};

export const ArchitectureBrowser = ({ atlas, onSelect, selection }: Props): React.JSX.Element => {
  // A link to a folder opens the tree down to it, and the folder itself.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    const linked = selectionOf(atlas, selection);
    return new Set([
      ...initiallyExpanded(atlas),
      ...(linked === null || linked.kind === "node"
        ? []
        : foldersRevealing(atlas, linked.path, true)),
    ]);
  });
  const [filter, setFilter] = useState("");
  const [hoverRow, setHoverRow] = useState<string | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);

  // A folder that appears after a redraw opens as the rest did.
  useEffect(() => {
    setExpanded((previous) => {
      const next = new Set(previous);
      const known = new Set(atlas.folders.map((folder) => folder.path));
      for (const folder of initiallyExpanded(atlas)) if (!previous.has(folder)) next.add(folder);
      for (const folder of previous) if (!known.has(folder)) next.delete(folder);
      return next;
    });
  }, [atlas]);

  const selected = useMemo(() => selectionOf(atlas, selection), [atlas, selection]);

  // Whatever is selected afterwards, from the detail pane or the hash, is
  // brought on screen: the folders above it open, and nothing else.
  const selectedPath = selected === null || selected.kind === "node" ? null : selected.path;
  useEffect(() => {
    if (selectedPath === null) return;
    const reveal = foldersRevealing(atlas, selectedPath, false);
    setExpanded((previous) =>
      reveal.every((folder) => previous.has(folder)) ? previous : new Set([...previous, ...reveal]),
    );
  }, [atlas, selectedPath]);
  const nodes = useMemo(
    () => new Map(atlas.manifest.nodes.map((node) => [node.id, node] as const)),
    [atlas],
  );
  const files = useMemo(
    () => new Map(atlas.files.map((file) => [file.path, file] as const)),
    [atlas],
  );
  const folders = useMemo(
    () => new Map(atlas.folders.map((folder) => [folder.path, folder] as const)),
    [atlas],
  );

  const filtered = useMemo(() => {
    if (filter.trim() === "") return null;
    const needle = filter.trim().toLowerCase();
    const keep = new Set<string>();
    for (const file of atlas.files) {
      if (!file.path.toLowerCase().includes(needle)) continue;
      keep.add(file.path);
      let folder = file.folder;
      while (folder !== "") {
        keep.add(folder);
        folder = folder.slice(0, Math.max(0, folder.lastIndexOf("/")));
      }
    }
    return keep;
  }, [atlas, filter]);

  const effectiveExpanded = useMemo(
    () =>
      filtered === null ? expanded : new Set([...filtered].filter((path) => folders.has(path))),
    [expanded, filtered, folders],
  );
  const rows = useMemo(() => {
    const all = rowsOf(atlas, effectiveExpanded);
    return filtered === null ? all : all.filter((row) => filtered.has(row.path));
  }, [atlas, effectiveExpanded, filtered]);
  const arcs = useMemo(
    () => arcsOf(atlas, rows, effectiveExpanded),
    [atlas, rows, effectiveExpanded],
  );

  // The focus: what the pointer is over, else what was clicked.
  const focusRow =
    hoverRow ?? (selected !== null && selected.kind !== "node" ? selected.path : null);
  const focusIsFolder = focusRow !== null && folders.has(focusRow);
  const relations = useMemo(
    () => relationsOf(atlas, focusRow, focusIsFolder),
    [atlas, focusRow, focusIsFolder],
  );
  const focusNode: AtlasNode | null = (() => {
    const id =
      hoverNode ??
      (selected?.kind === "node"
        ? selected.id
        : focusRow === null
          ? null
          : (files.get(focusRow)?.node ?? folders.get(focusRow)?.node ?? null));
    return id === null ? null : (nodes.get(id) ?? null);
  })();
  const chain: ReadonlyArray<string> =
    focusRow === null
      ? focusNode === null
        ? []
        : chainOfNode(nodes, focusNode)
      : (files.get(focusRow)?.chain ?? (focusNode === null ? [] : chainOfNode(nodes, focusNode)));
  const governedBy: string | null = hoverNode ?? (selected?.kind === "node" ? selected.id : null);

  // A node hovered in the manifest is already on screen. Scrolling to its
  // anchor would put a different line under the pointer, which would hover a
  // different node and scroll again, so only a focus from outside the
  // manifest moves it.
  const scrollTo: AtlasPosition | null = hoverNode === null ? (focusNode?.position ?? null) : null;

  const select = (next: Selection | null): void => {
    onSelect(textOf(next));
  };
  const toggle = (folder: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  return (
    <div className="arch">
      <section className="pane tree-pane" aria-label="Repository tree">
        <div className="pane-head">
          <input
            className="filter"
            type="search"
            placeholder="filter files…"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
          <button
            type="button"
            className="small"
            onClick={() => {
              setExpanded(new Set(atlas.folders.map((folder) => folder.path)));
            }}
          >
            expand
          </button>
          <button
            type="button"
            className="small"
            onClick={() => {
              setExpanded(new Set());
            }}
          >
            collapse
          </button>
        </div>
        <Tree
          rows={rows}
          arcs={arcs}
          focus={focusRow}
          focusIsFolder={focusIsFolder}
          relations={relations}
          governedBy={governedBy}
          chain={chain}
          nodes={nodes}
          selected={selected !== null && selected.kind !== "node" ? selected.path : null}
          onHover={setHoverRow}
          onToggle={toggle}
          onSelect={(row) => {
            select(
              row.kind === "folder"
                ? { kind: "folder", path: row.path }
                : { kind: "file", path: row.path },
            );
          }}
        />
        <Legend />
      </section>
      <section className="pane manifest-pane" aria-label="architecture.yaml">
        <ManifestPane
          atlas={atlas}
          activeNode={focusNode?.id ?? null}
          chain={chain}
          scrollTo={scrollTo}
          selectedNode={selected?.kind === "node" ? selected.id : null}
          onHoverNode={setHoverNode}
          onSelectNode={(id) => {
            select(id === null ? null : { kind: "node", id });
          }}
        />
      </section>
      <section className="pane detail-pane" aria-label="Details">
        <Detail
          atlas={atlas}
          selected={selected}
          hovered={
            hoverRow === null
              ? hoverNode === null
                ? null
                : { kind: "node", id: hoverNode }
              : folders.has(hoverRow)
                ? { kind: "folder", path: hoverRow }
                : { kind: "file", path: hoverRow }
          }
          onSelect={select}
        />
      </section>
    </div>
  );
};

const chainOfNode = (
  nodes: ReadonlyMap<string, AtlasNode>,
  node: AtlasNode,
): ReadonlyArray<string> => {
  const chain: Array<string> = [];
  let cursor: AtlasNode | undefined = node;
  while (cursor !== undefined) {
    chain.unshift(cursor.id);
    cursor = cursor.parent === null ? undefined : nodes.get(cursor.parent);
  }
  return chain;
};

const Legend = (): React.JSX.Element => (
  <div className="legend">
    <span className="key out">imports</span>
    <span className="key in">imported by</span>
    <span className="key both">both ways</span>
    <span className="key refused">refused</span>
    <span className="key sibling">owed sibling</span>
    <span className="key governed">governed by node</span>
  </div>
);
