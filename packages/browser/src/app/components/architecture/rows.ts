import type { Atlas, AtlasEdge, AtlasFile, AtlasFolder } from "../../../model/atlas.js";

// The tree as rows, and the edges as arcs between rows. A folder collapsed
// stands in for everything under it: an edge into a hidden file lands on the
// nearest visible ancestor, and edges between two files of one collapsed
// folder are not drawn. Pure, so the drawing can be tested without a DOM.

export type Row =
  | {
      readonly kind: "folder";
      readonly path: string;
      readonly name: string;
      readonly depth: number;
      readonly expanded: boolean;
      readonly folder: AtlasFolder;
      readonly files: number;
      readonly violations: number;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly name: string;
      readonly depth: number;
      readonly file: AtlasFile;
    };

export type Arc = {
  readonly from: number;
  readonly to: number;
  readonly edges: ReadonlyArray<AtlasEdge>;
  readonly refused: boolean;
};

type Tree = {
  readonly folders: ReadonlyMap<string, ReadonlyArray<AtlasFolder>>;
  readonly files: ReadonlyMap<string, ReadonlyArray<AtlasFile>>;
  readonly filesUnder: ReadonlyMap<string, number>;
  readonly violationsUnder: ReadonlyMap<string, number>;
};

const parentOf = (path: string): string => {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
};

export const treeOf = (atlas: Atlas): Tree => {
  const folders = new Map<string, Array<AtlasFolder>>();
  for (const folder of atlas.folders) {
    const key = folder.parent ?? "";
    const held = folders.get(key) ?? [];
    held.push(folder);
    folders.set(key, held);
  }
  const files = new Map<string, Array<AtlasFile>>();
  const filesUnder = new Map<string, number>();
  const violationsUnder = new Map<string, number>();
  for (const file of atlas.files) {
    const held = files.get(file.folder) ?? [];
    held.push(file);
    files.set(file.folder, held);
    let folder = file.folder;
    while (folder !== "") {
      filesUnder.set(folder, (filesUnder.get(folder) ?? 0) + 1);
      violationsUnder.set(folder, (violationsUnder.get(folder) ?? 0) + file.violations);
      folder = parentOf(folder);
    }
  }
  for (const held of folders.values()) held.sort((a, b) => a.name.localeCompare(b.name));
  for (const held of files.values()) held.sort((a, b) => a.name.localeCompare(b.name));
  return { folders, files, filesUnder, violationsUnder };
};

// Folders first, then files, each alphabetically; a folder is walked into
// only when expanded.
export const rowsOf = (atlas: Atlas, expanded: ReadonlySet<string>): ReadonlyArray<Row> => {
  const tree = treeOf(atlas);
  const rows: Array<Row> = [];
  const visit = (folder: string, depth: number): void => {
    for (const child of tree.folders.get(folder) ?? []) {
      const isExpanded = expanded.has(child.path);
      rows.push({
        kind: "folder",
        path: child.path,
        name: child.name,
        depth,
        expanded: isExpanded,
        folder: child,
        files: tree.filesUnder.get(child.path) ?? 0,
        violations: tree.violationsUnder.get(child.path) ?? 0,
      });
      if (isExpanded) visit(child.path, depth + 1);
    }
    for (const file of tree.files.get(folder) ?? []) {
      rows.push({ kind: "file", path: file.path, name: file.name, depth, file });
    }
  };
  visit("", 0);
  return rows;
};

// The row a file lands on: its own, or the nearest visible ancestor's.
export const rowIndexOf = (
  rows: ReadonlyArray<Row>,
  expanded: ReadonlySet<string>,
): ((file: string) => number) => {
  const index = new Map(rows.map((row, i) => [row.path, i] as const));
  return (file) => {
    let path = file;
    while (path !== "") {
      const found = index.get(path);
      if (found !== undefined && (path === file || !expanded.has(path))) return found;
      path = parentOf(path);
    }
    return -1;
  };
};

export const arcsOf = (
  atlas: Atlas,
  rows: ReadonlyArray<Row>,
  expanded: ReadonlySet<string>,
): ReadonlyArray<Arc> => {
  const at = rowIndexOf(rows, expanded);
  const arcs = new Map<string, { from: number; to: number; edges: Array<AtlasEdge> }>();
  for (const edge of atlas.edges) {
    const from = at(edge.from);
    const to = at(edge.to);
    if (from === -1 || to === -1 || from === to) continue;
    const key = `${String(from)}>${String(to)}`;
    const held = arcs.get(key);
    if (held === undefined) arcs.set(key, { from, to, edges: [edge] });
    else held.edges.push(edge);
  }
  return [...arcs.values()].map((arc) => ({
    ...arc,
    refused: arc.edges.some((edge) => edge.status === "refused"),
  }));
};

// Every folder, for a tree that opens fully; or the folders down to a depth,
// for one too large to.
export const initiallyExpanded = (atlas: Atlas): ReadonlySet<string> => {
  const open = atlas.files.length <= 600;
  return new Set(
    atlas.folders.filter((folder) => open || folder.depth < 2).map((folder) => folder.path),
  );
};

// What a focus on one row means for every other: the files it reaches, the
// files that reach it, the siblings it owes, and the files under it.
export type Relation = "focus" | "dep" | "importer" | "sibling" | "within" | null;

export const relationsOf = (
  atlas: Atlas,
  focus: string | null,
  isFolder: boolean,
): ReadonlyMap<string, Relation> => {
  const relations = new Map<string, Relation>();
  if (focus === null) return relations;
  const inside = (path: string): boolean =>
    isFolder ? path.startsWith(`${focus}/`) : path === focus;
  relations.set(focus, "focus");
  for (const edge of atlas.edges) {
    const fromIn = inside(edge.from);
    const toIn = inside(edge.to);
    if (fromIn && toIn) {
      if (isFolder) {
        relations.set(edge.from, "within");
        relations.set(edge.to, "within");
      }
    } else if (fromIn && !relations.has(edge.to)) relations.set(edge.to, "dep");
    else if (toIn && !relations.has(edge.from)) relations.set(edge.from, "importer");
  }
  if (!isFolder) {
    const file = atlas.files.find((one) => one.path === focus);
    for (const owed of file?.requires ?? []) {
      if (!relations.has(owed.sibling)) relations.set(owed.sibling, "sibling");
    }
  }
  return relations;
};
