import type { Manifest, ManifestNode } from "./manifest.js";

// The as-built manifest: the inverse of a probe.
//
// A probe goes from a rule to a synthetic fact and proves the rule can fire.
// This goes from the real facts — every walked file and every edge it has — to
// a manifest in the policy's own vocabulary that describes what the tree does
// today: one node per folder to a depth, every folder `layout: open`, every
// node `unrestricted: true` with its `imports.allow` filled from the edges its
// files actually have. `check` accepts it with zero violations, by
// construction; the human edits it down, and every edit is a constraint.
//
// Nothing here reads a file or resolves a specifier. The host walks, parses
// and resolves, and hands the answers in; this tier decides what they say.

export type InferredTarget =
  // A file on disk, repo-relative — walked or not. One outside every walk root
  // is admitted by its exact path, since no node describes it.
  | { readonly kind: "local"; readonly path: string }
  // An npm package, a Go module: named as `imports.external` names it.
  | { readonly kind: "external"; readonly package: string }
  // The runtime's own — `node:fs` — admitted by its exact name, so the
  // manifest names no runtime the tree does not use.
  | { readonly kind: "builtin"; readonly path: string };

export type InferPackage = {
  // Repo-relative folder holding a package marker; `""` is the repository.
  readonly root: string;
  // Its source folder when the language keeps one; `infer` counts depth from
  // there, so `packages/core/src/domain` is one below `src`, not four below
  // the root.
  readonly source: string | null;
};

export type InferInput = {
  // Every walked file, repo-relative with forward slashes.
  readonly files: ReadonlyArray<string>;
  readonly targetsOf: (file: string) => ReadonlyArray<InferredTarget>;
  // The walk roots: folders, repo-relative, no trailing slash. Each becomes a
  // top-level key of the tree.
  readonly roots: ReadonlyArray<string>;
  readonly packages: ReadonlyArray<InferPackage>;
  // How many folders below a package's source root (or the walk root, outside
  // any package) become nodes of their own. Deeper folders are governed by
  // the node above them.
  readonly depth: number;
};

// A set of sibling folders that look like members of one layer — each with
// the same subfolders, or the same kinds of file — and could be one
// wildcarded node instead of one node each.
export type Candidate = {
  readonly parent: string;
  readonly members: ReadonlyArray<string>;
  readonly sharedFolders: ReadonlyArray<string>;
  readonly sharedStereotypes: ReadonlyArray<string>;
  // The capture the wildcarded key would declare: `{module}` under `modules/`.
  readonly capture: string;
  // How many edges run from one member into another, and — when every one of
  // them lands on the same member-relative path, such as `index.ts` — that
  // path, which is the tightening a human would write next.
  readonly crossEdges: number;
  readonly crossReach: string | null;
};

// A candidate the host accepted, with or without the tightening.
export type Generalization = {
  readonly parent: string;
  readonly members: ReadonlyArray<string>;
  readonly capture: string;
  readonly crossReach: string | null;
};

export type InferOptions = {
  readonly generalize: ReadonlyArray<Generalization>;
  // Fold a node's children into it when every child has the same allow set.
  readonly collapse: boolean;
  // Written into every node's message, so the reader knows how old it is.
  readonly date: string;
  readonly resolve: Manifest["resolve"];
  // Carried over from an existing manifest, and used to shorten what is
  // written: `packages/core/src/**` reads better as `@core/**`.
  readonly aliases?: Readonly<Record<string, string>> | undefined;
  readonly baseline: string;
  // Whether the graph has a cycle today. A no-cycles rule is written only
  // when the tree passes it: a rule it fails on day one is debt, not shape.
  readonly hasCycles: boolean;
};

export type Inferred = {
  readonly manifest: Manifest;
  readonly nodes: number;
  readonly files: number;
};

// ---------------------------------------------------------------------------
// Paths

const dirnameOf = (file: string): string => {
  const at = file.lastIndexOf("/");
  return at === -1 ? "" : file.slice(0, at);
};

const basenameOf = (file: string): string => file.slice(file.lastIndexOf("/") + 1);

// `folder` is `p` or an ancestor of it. The empty folder is every path's.
const isUnder = (p: string, folder: string): boolean =>
  folder === "" || p === folder || p.startsWith(`${folder}/`);

const depthBelow = (p: string, folder: string): number =>
  p === folder ? 0 : (folder === "" ? p : p.slice(folder.length + 1)).split("/").length;

const sorted = <T>(items: Iterable<T>): ReadonlyArray<T> => [...items].sort();

// ---------------------------------------------------------------------------
// Generalization: a member folder is rewritten as its capture, so the tree is
// built once over the rewritten paths and the members merge on their own.

type Membership = { readonly group: Generalization; readonly member: string };

const memberOf = (p: string, generalize: ReadonlyArray<Generalization>): Membership | null => {
  for (const group of generalize) {
    for (const member of group.members) {
      const folder = group.parent === "" ? member : `${group.parent}/${member}`;
      if (isUnder(p, folder)) return { group, member };
    }
  }
  return null;
};

const capturedPathOf = (group: Generalization): string =>
  group.parent === "" ? `{${group.capture}}` : `${group.parent}/{${group.capture}}`;

const rewrite = (p: string, generalize: ReadonlyArray<Generalization>): string => {
  const membership = memberOf(p, generalize);
  if (membership === null) return p;
  const { group, member } = membership;
  const folder = group.parent === "" ? member : `${group.parent}/${member}`;
  const captured = capturedPathOf(group);
  return p === folder ? captured : `${captured}${p.slice(folder.length)}`;
};

// ---------------------------------------------------------------------------
// The folder trie of the walked files, over rewritten paths.

type Folder = {
  readonly path: string;
  readonly name: string;
  // Original paths of the files directly in it.
  readonly files: Array<string>;
  readonly children: Map<string, Folder>;
};

const folderAt = (root: Folder, p: string): Folder => {
  if (p === root.path) return root;
  const rest = root.path === "" ? p : p.slice(root.path.length + 1);
  let at = root;
  for (const segment of rest.split("/")) {
    const existing = at.children.get(segment);
    if (existing !== undefined) {
      at = existing;
      continue;
    }
    const made: Folder = {
      path: at.path === "" ? segment : `${at.path}/${segment}`,
      name: segment,
      files: [],
      children: new Map(),
    };
    at.children.set(segment, made);
    at = made;
  }
  return at;
};

type Trie = ReadonlyArray<Folder>;

const trieOf = (input: InferInput, generalize: ReadonlyArray<Generalization>): Trie => {
  const roots = input.roots.map((root): Folder => ({
    path: root,
    name: basenameOf(root),
    files: [],
    children: new Map(),
  }));
  for (const file of input.files) {
    const folder = rewrite(dirnameOf(file), generalize);
    const root = roots.find((one) => isUnder(folder, one.path));
    if (root === undefined) continue;
    folderAt(root, folder).files.push(file);
  }
  return roots;
};

// ---------------------------------------------------------------------------
// Which folders are nodes.

type Bases = {
  // Every folder a depth is counted from: the walk roots, the package roots,
  // the package source roots — all rewritten.
  readonly all: ReadonlyArray<string>;
};

const basesOf = (input: InferInput, generalize: ReadonlyArray<Generalization>): Bases => {
  const all = new Set<string>(input.roots);
  for (const one of input.packages) {
    all.add(rewrite(one.root, generalize));
    if (one.source !== null) all.add(rewrite(one.source, generalize));
  }
  return { all: sorted(all) };
};

const baseOf = (folder: string, bases: Bases): string => {
  let best: string | null = null;
  for (const base of bases.all) {
    if (!isUnder(folder, base)) continue;
    if (best === null || base.length > best.length) best = base;
  }
  return best ?? "";
};

// A folder is a node when it is within `depth` of the base it counts from, or
// when it lies on the way to one — the folders between a walk root and a
// package are structure, and a node each whatever the depth.
const isNode = (folder: Folder, input: InferInput, bases: Bases): boolean =>
  input.roots.includes(folder.path) ||
  bases.all.some((base) => isUnder(base, folder.path)) ||
  depthBelow(folder.path, baseOf(folder.path, bases)) <= input.depth;

// ---------------------------------------------------------------------------
// The node tree.

type Node = {
  readonly path: string;
  readonly key: string;
  readonly folder: Folder;
  // Original paths of every file this node governs: its own, and those in
  // the folders beneath it that are not nodes.
  files: Array<string>;
  children: Map<string, Node>;
  // Whether a folder beneath it holds files without being a node — which the
  // manifest must admit with a catch-all, or the structure family fires.
  stray: boolean;
  allow: Set<string>;
  external: Set<string>;
  edges: number;
};

const nodeOf = (folder: Folder, input: InferInput, bases: Bases): Node => {
  const node: Node = {
    path: folder.path,
    key: `${folder.name}/`,
    folder,
    files: [...folder.files],
    children: new Map(),
    stray: false,
    allow: new Set(),
    external: new Set(),
    edges: 0,
  };
  const absorb = (from: Folder): void => {
    for (const child of from.children.values()) {
      if (isNode(child, input, bases)) {
        node.children.set(child.name, nodeOf(child, input, bases));
      } else {
        node.stray = true;
        for (const file of child.files) node.files.push(file);
        absorb(child);
      }
    }
  };
  absorb(folder);
  return node;
};

// The deepest node whose folder holds `p` (a rewritten path), or null when
// no walk root does.
const governorOf = (p: string, roots: ReadonlyArray<Node>): Node | null => {
  const root = roots.find((one) => isUnder(p, one.path));
  if (root === undefined) return null;
  const descend = (at: Node): Node => {
    for (const child of at.children.values()) if (isUnder(p, child.path)) return descend(child);
    return at;
  };
  return descend(root);
};

const eachNode = (roots: ReadonlyArray<Node>, visit: (node: Node) => void): void => {
  const walk = (node: Node): void => {
    visit(node);
    for (const child of node.children.values()) walk(child);
  };
  for (const root of roots) walk(root);
};

// ---------------------------------------------------------------------------
// Allow sets.

// What a local target is written as: the node that governs it, as a glob. A
// file directly in a node that has children of its own is `node/*` — the
// layer's own files, such as a barrel, and not the tiers beneath — and
// anything else is `node/**`. A capture in that path survives only when the
// importer is in the same member; from anywhere else it is `*`.
const entryFor = (
  importer: string,
  target: string,
  roots: ReadonlyArray<Node>,
  generalize: ReadonlyArray<Generalization>,
): string => {
  const rewritten = rewrite(target, generalize);
  const node = governorOf(rewritten, roots);
  if (node === null) return target;

  const from = memberOf(importer, generalize);
  const to = memberOf(target, generalize);
  const sameGroup =
    from !== null &&
    to !== null &&
    from.group.parent === to.group.parent &&
    from.group.capture === to.group.capture;
  if (to !== null && sameGroup && to.member !== from.member) {
    const reach = to.group.crossReach;
    const folder = to.group.parent === "" ? to.member : `${to.group.parent}/${to.member}`;
    if (reach !== null && target === `${folder}/${reach}`) {
      return `${to.group.parent === "" ? "" : `${to.group.parent}/`}*/${reach}`;
    }
  }

  const direct = dirnameOf(rewritten) === node.path && node.children.size > 0;
  const glob = `${node.path}/${direct ? "*" : "**"}`;
  if (to === null) return glob;
  const sameMember = sameGroup && from.member === to.member;
  return sameMember ? glob : glob.replace(`{${to.group.capture}}`, "*");
};

const fillAllowSets = (
  roots: ReadonlyArray<Node>,
  input: InferInput,
  generalize: ReadonlyArray<Generalization>,
): void => {
  eachNode(roots, (node) => {
    for (const file of node.files) {
      for (const target of input.targetsOf(file)) {
        node.edges += 1;
        switch (target.kind) {
          case "local":
            node.allow.add(entryFor(file, target.path, roots, generalize));
            break;
          case "builtin":
            node.allow.add(target.path);
            break;
          case "external":
            node.external.add(target.package);
            break;
        }
      }
    }
  });
};

// ---------------------------------------------------------------------------
// Candidates: siblings that share a shape.

// `auth.module.ts` and `user.module.ts` are one kind of file; `index.ts` is
// its own. The first segment is the name, the rest is what it is.
const stereotypeOf = (file: string): string => {
  const parts = basenameOf(file).split(".");
  return parts.length >= 3 ? `*.${parts.slice(1).join(".")}` : basenameOf(file);
};

const intersect = (a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlyArray<string> =>
  sorted([...a].filter((one) => b.has(one)));

const alike = (a: Shape, b: Shape): boolean => {
  if (intersect(a.folders, b.folders).length >= 2) return true;
  const union = new Set([...a.stereotypes, ...b.stereotypes]);
  return union.size > 0 && intersect(a.stereotypes, b.stereotypes).length / union.size >= 0.5;
};

type Shape = { readonly folders: ReadonlySet<string>; readonly stereotypes: ReadonlySet<string> };

const shapeOf = (folder: Folder): Shape => ({
  folders: new Set(folder.children.keys()),
  stereotypes: new Set(folder.files.map(stereotypeOf)),
});

// `modules` → `module`; `entities` → `entity`; `packages` → `package`. What a
// human would name the capture; anything unpronounceable is `name`.
export const singularOf = (plural: string): string => {
  const word = plural.replace(/[^A-Za-z0-9]/g, "");
  const singular = /ies$/.test(word)
    ? word.replace(/ies$/, "y")
    : /(ses|xes|zes|shes|ches)$/.test(word)
      ? word.slice(0, -2)
      : /[^s]s$/.test(word)
        ? word.slice(0, -1)
        : word;
  return singular === "" || /^[0-9]/.test(singular) ? "name" : singular;
};

const groupsOf = (
  members: ReadonlyArray<[string, Shape]>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const parent = new Map<string, string>(members.map(([name]) => [name, name]));
  const find = (name: string): string => {
    let at = name;
    while ((parent.get(at) ?? at) !== at) at = parent.get(at) ?? at;
    return at;
  };
  for (const [i, [a, shapeA]] of members.entries()) {
    for (const [b, shapeB] of members.slice(i + 1)) {
      if (alike(shapeA, shapeB)) parent.set(find(a), find(b));
    }
  }
  const groups = new Map<string, Array<string>>();
  for (const [name] of members) {
    const key = find(name);
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  return [...groups.values()]
    .filter((group) => group.length >= 2)
    .map((group) => sorted(group))
    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
};

// The sibling groups under every node of the tree as it stands with the
// generalizations already accepted — never inside one, since a generalized
// node's children are already a merge.
export const candidatesOf = (
  input: InferInput,
  generalize: ReadonlyArray<Generalization> = [],
): ReadonlyArray<Candidate> => {
  const trie = trieOf(input, generalize);
  const bases = basesOf(input, generalize);
  const roots = trie.map((folder) => nodeOf(folder, input, bases));
  const candidates: Array<Candidate> = [];

  eachNode(roots, (node) => {
    if (node.path.includes("{") || node.children.size < 2) return;
    const members: ReadonlyArray<[string, Shape]> = sorted(node.children.keys()).flatMap((name) => {
      const folder = node.folder.children.get(name);
      return folder === undefined ? [] : [[name, shapeOf(folder)] as [string, Shape]];
    });
    const shapes = new Map(members);
    const taken = new Set<string>();
    for (const group of groupsOf(members)) {
      const shapesOfGroup = group.flatMap((name) => {
        const shape = shapes.get(name);
        return shape === undefined ? [] : [shape];
      });
      const sharedOf = (pick: (shape: Shape) => ReadonlySet<string>): ReadonlyArray<string> => {
        const [head, ...rest] = shapesOfGroup;
        if (head === undefined) return [];
        return sorted(
          rest.reduce<ReadonlySet<string>>(
            (acc, shape) => new Set(intersect(acc, pick(shape))),
            pick(head),
          ),
        );
      };
      const sharedFolders = sharedOf((shape) => shape.folders);
      const sharedStereotypes = sharedOf((shape) => shape.stereotypes);
      let capture = singularOf(node.folder.name);
      for (let n = 2; taken.has(capture); n += 1)
        capture = `${singularOf(node.folder.name)}${String(n)}`;
      taken.add(capture);

      // Edges between members, and whether they all land on one place.
      const memberFolder = (name: string): string =>
        node.path === "" ? name : `${node.path}/${name}`;
      const isIn = (p: string): string | null =>
        group.find((name) => isUnder(p, memberFolder(name))) ?? null;
      let crossEdges = 0;
      const landings = new Set<string>();
      for (const file of input.files) {
        const from = isIn(file);
        if (from === null) continue;
        for (const target of input.targetsOf(file)) {
          if (target.kind !== "local") continue;
          const to = isIn(target.path);
          if (to === null || to === from) continue;
          crossEdges += 1;
          landings.add(target.path.slice(memberFolder(to).length + 1));
        }
      }
      const [landing] = sorted(landings);
      candidates.push({
        parent: node.path,
        members: group,
        sharedFolders,
        sharedStereotypes,
        capture,
        crossEdges,
        crossReach: landings.size === 1 && landing !== undefined ? landing : null,
      });
    }
  });

  return candidates.sort((a, b) => {
    const byParent = a.parent.localeCompare(b.parent);
    return byParent !== 0 ? byParent : (a.members[0] ?? "").localeCompare(b.members[0] ?? "");
  });
};

// ---------------------------------------------------------------------------
// Collapse: children that all reach the same things are one node.

const normalized = (node: Node, under: string): ReadonlyArray<string> =>
  sorted(new Set([...node.allow].map((entry) => (isUnder(entry, under) ? `${under}/**` : entry))));

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((one, index) => one === b[index]);

const collapse = (node: Node): void => {
  for (const child of node.children.values()) collapse(child);
  if (node.children.size === 0) return;
  const children = [...node.children.values()];
  if (children.some((child) => child.children.size > 0)) return;

  const [first] = children;
  if (first === undefined) return;
  const shared = normalized(first, node.path);
  const externals = sorted(first.external);
  const agree = children.every(
    (child) =>
      sameList(normalized(child, node.path), shared) && sameList(sorted(child.external), externals),
  );
  if (!agree) return;
  const own = normalized(node, node.path);
  if (!own.every((entry) => shared.includes(entry))) return;
  if (!sorted(node.external).every((entry) => externals.includes(entry))) return;

  node.allow = new Set(shared);
  node.external = new Set(externals);
  for (const child of children) {
    for (const file of child.files) node.files.push(file);
    node.edges += child.edges;
  }
  node.children = new Map();
  node.stray = true;
};

// ---------------------------------------------------------------------------
// Emitting.

const shortenWith = (aliases: Readonly<Record<string, string>>) => {
  const entries = Object.entries(aliases).sort(([, a], [, b]) => b.length - a.length);
  return (p: string): string => {
    for (const [alias, target] of entries) {
      if (p === target) return alias;
      if (p.startsWith(`${target}/`)) return `${alias}${p.slice(target.length)}`;
    }
    return p;
  };
};

const CATCH_ALL = "**/";

export const inferManifest = (input: InferInput, options: InferOptions): Inferred => {
  const { generalize } = options;
  const trie = trieOf(input, generalize);
  const bases = basesOf(input, generalize);
  const roots = trie.map((folder) => nodeOf(folder, input, bases));
  fillAllowSets(roots, input, generalize);
  if (options.collapse) for (const root of roots) collapse(root);

  const shorten = shortenWith(options.aliases ?? {});
  let unrestricted = 0;
  let nodes = 0;
  let files = 0;

  const describe = (node: Node): string => {
    const membership = generalize.find((group) => capturedPathOf(group) === node.path);
    const across =
      membership === undefined
        ? ""
        : ` across ${String(membership.members.length)} ${basenameOf(membership.parent)} (${membership.members.join(", ")})`;
    const count = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
    return node.files.length === 0
      ? `As built on ${options.date}: no files of its own.`
      : `As built on ${options.date}${across}: ${count(node.files.length, "file")}, ${count(node.edges, "edge")}.`;
  };

  const emit = (node: Node): ManifestNode => {
    nodes += 1;
    files += node.files.length;
    const children: Record<string, ManifestNode> = {};
    for (const name of sorted(node.children.keys())) {
      const child = node.children.get(name);
      if (child !== undefined) children[child.key] = emit(child);
    }
    if (node.stray) children[CATCH_ALL] = { layout: "open", children: {} };

    const imports =
      node.files.length === 0
        ? {}
        : {
            imports: {
              message: `This import is not on the allowlist infer wrote for ${node.path}/ on ${options.date}. Add it by name if it belongs here.`,
              unrestricted: true,
              ...(node.allow.size > 0 ? { allow: sorted([...node.allow].map(shorten)) } : {}),
              ...(node.external.size > 0 ? { external: sorted(node.external) } : {}),
            },
          };
    if (node.files.length > 0) unrestricted += 1;

    return {
      message: describe(node),
      layout: "open",
      ...imports,
      children,
    };
  };

  const tree: Record<string, ManifestNode> = {};
  for (const root of roots) tree[`${shorten(root.path)}/`] = emit(root);

  const within = input.roots.map((root) => shorten(`${root}/**`));
  const manifest: Manifest = {
    resolve: options.resolve,
    baseline: options.baseline,
    ...(options.aliases === undefined || Object.keys(options.aliases).length === 0
      ? {}
      : { aliases: options.aliases }),
    limits: { unrestricted, partial: 0 },
    ...(options.hasCycles
      ? {}
      : {
          graph: {
            cycles: [
              {
                name: "no-cycles",
                message:
                  "These files import each other, directly or through others. The tree had no cycle when this manifest was inferred; keep it that way.",
                within: within.length === 1 ? (within[0] ?? "") : within,
              },
            ],
          },
        }),
    tree,
  };

  return { manifest, nodes, files };
};
