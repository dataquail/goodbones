// The folder tree of a set of walked files: a trie of folders, each holding the
// files directly in it and the folders beneath. What `infer` describes one node
// per folder of, and what the atlas rolls edges up to. Nothing here reads a
// file; the walker hands the paths in.

export type Folder = {
  // Repo-relative, forward slashes, no trailing slash; `""` is the repository.
  readonly path: string;
  // The last segment of `path`.
  readonly name: string;
  // The files directly in this folder, in the order they were added.
  readonly files: Array<string>;
  readonly children: Map<string, Folder>;
};

export const dirnameOf = (file: string): string => {
  const at = file.lastIndexOf("/");
  return at === -1 ? "" : file.slice(0, at);
};

export const basenameOf = (file: string): string => file.slice(file.lastIndexOf("/") + 1);

// `folder` is `p` or an ancestor of it. The empty folder is every path's.
export const isUnder = (p: string, folder: string): boolean =>
  folder === "" || p === folder || p.startsWith(`${folder}/`);

// Every ancestor folder of a path, nearest first, the root (`""`) excluded.
export const ancestorsOf = (p: string): ReadonlyArray<string> => {
  const folders: Array<string> = [];
  let folder = dirnameOf(p);
  while (folder !== "") {
    folders.push(folder);
    folder = dirnameOf(folder);
  }
  return folders;
};

export const makeFolder = (path: string): Folder => ({
  path,
  name: basenameOf(path),
  files: [],
  children: new Map(),
});

// The folder at `p` under `root`, created along with any missing ancestors.
// `p` must be `root.path` or beneath it.
export const folderAt = (root: Folder, p: string): Folder => {
  if (p === root.path) return root;
  const rest = root.path === "" ? p : p.slice(root.path.length + 1);
  let at = root;
  for (const segment of rest.split("/")) {
    const existing = at.children.get(segment);
    if (existing !== undefined) {
      at = existing;
      continue;
    }
    const made = makeFolder(at.path === "" ? segment : `${at.path}/${segment}`);
    at.children.set(segment, made);
    at = made;
  }
  return at;
};

// One trie per walk root, holding every file under it. `folderOf` says which
// folder a file is filed under — its own directory by default; `infer` passes
// one that rewrites a generalized member to its capture, so sibling folders
// that are one node merge as the trie is built. A file under no root is
// dropped.
export const trieOf = (
  files: ReadonlyArray<string>,
  roots: ReadonlyArray<string>,
  folderOf: (file: string) => string = dirnameOf,
): ReadonlyArray<Folder> => {
  const tries = roots.map(makeFolder);
  for (const file of files) {
    const folder = folderOf(file);
    const root = tries.find((one) => isUnder(folder, one.path));
    if (root === undefined) continue;
    folderAt(root, folder).files.push(file);
  }
  return tries;
};

// The folder at exactly `p` in one of the tries, or null.
export const findFolder = (tries: ReadonlyArray<Folder>, p: string): Folder | null => {
  const root = tries.find((one) => isUnder(p, one.path));
  if (root === undefined) return null;
  if (p === root.path) return root;
  let at = root;
  const rest = root.path === "" ? p : p.slice(root.path.length + 1);
  for (const segment of rest.split("/")) {
    const next = at.children.get(segment);
    if (next === undefined) return null;
    at = next;
  }
  return at;
};

// Every file in the folder and beneath it, in trie order.
export const filesBeneath = (folder: Folder): ReadonlyArray<string> => {
  const found: Array<string> = [];
  eachNode([folder], (one) => {
    for (const file of one.files) found.push(file);
  });
  return found;
};

// Any tree whose nodes hold their children by name — a `Folder`, or the node
// tree `infer` builds over one.
export type TreeNode<T> = { readonly path: string; readonly children: Map<string, T> };

// The deepest node whose path holds `p`, or null when no root does.
export const deepestContaining = <T extends TreeNode<T>>(
  roots: ReadonlyArray<T>,
  p: string,
): T | null => {
  const root = roots.find((one) => isUnder(p, one.path));
  if (root === undefined) return null;
  const descend = (at: T): T => {
    for (const child of at.children.values()) if (isUnder(p, child.path)) return descend(child);
    return at;
  };
  return descend(root);
};

// Pre-order over every node of every tree.
export const eachNode = <T extends TreeNode<T>>(
  roots: ReadonlyArray<T>,
  visit: (node: T) => void,
): void => {
  const walk = (node: T): void => {
    visit(node);
    for (const child of node.children.values()) walk(child);
  };
  for (const root of roots) walk(root);
};
