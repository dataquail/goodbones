import {
  type Atlas,
  type AtlasEdge,
  type AtlasEdgeStatus,
  BUILTIN_PREFIX,
  isExternalTarget,
  PACKAGE_PREFIX,
} from "../domain/atlas.js";
import {
  ancestorsOf,
  basenameOf,
  dirnameOf,
  filesBeneath,
  findFolder,
  type Folder,
  isUnder,
  trieOf,
} from "../domain/tree.js";

// One folder of the atlas, rolled up: its children as nodes, the atlas edges
// between them summed into one edge per pair, and the edges leaving it
// collapsed onto the nearest thing outside. Every folder is a diagram of its
// children, and this is that diagram as data — the mermaid renderer and the
// explorer draw it; neither decides what an edge means. Pure, so it runs in
// Node and in the browser alike.

export type ViewOptions = {
  // How many levels of the focus to show: its children, or its children with
  // their own children inside them.
  readonly depth: 1 | 2;
  // What to do with an edge leaving the focus: draw its far end as one node
  // for the nearest sibling of an ancestor (or the package), or leave it out.
  readonly outside: "collapse" | "hide";
  // Whether to draw an allowance nothing uses as a ghost edge.
  readonly designed: boolean;
};

export const DEFAULT_VIEW_OPTIONS: ViewOptions = { depth: 1, outside: "collapse", designed: false };

export type ViewNodeKind = "folder" | "file" | "outside" | "package" | "builtin";

export type ViewBadges = {
  readonly violations: number;
  readonly baselined: number;
  readonly cycles: number;
  readonly unrestricted: boolean;
  readonly partial: boolean;
};

export type ViewNode = {
  // The folder or file path; `pkg:<name>` or `builtin:<name>` for an external.
  readonly id: string;
  readonly kind: ViewNodeKind;
  readonly label: string;
  // The `name` of the deepest manifest node that governs everything beneath,
  // or null when none does.
  readonly node: string | null;
  readonly message?: string;
  // The innermost layer every file beneath is in, when they are in one.
  readonly layer?: string;
  readonly files: number;
  // Files beneath that no family reaches.
  readonly residue: number;
  readonly badges: ViewBadges;
  // With `depth: 2`, a folder's own children — the units the edges run between.
  readonly children?: ReadonlyArray<ViewNode>;
};

// `designed` is an allowance with no observed edge under it: allowed, no traffic.
export type ViewEdgeStatus = AtlasEdgeStatus | "designed";

export type ViewEdge = {
  readonly from: string;
  readonly to: string;
  readonly status: ViewEdgeStatus;
  // Observed file-to-file imports beneath the edge; 0 for a designed one.
  readonly count: number;
  readonly worst: { readonly fingerprint: string; readonly message: string } | null;
  readonly underlying: ReadonlyArray<AtlasEdge>;
};

export type View = {
  readonly focus: string;
  // Every folder from the repository root down to the focus, the root (`""`)
  // first and the focus last.
  readonly crumbs: ReadonlyArray<string>;
  readonly members: ReadonlyArray<ViewNode>;
  readonly outside: ReadonlyArray<ViewNode>;
  readonly edges: ReadonlyArray<ViewEdge>;
};

const SEVERITY: Readonly<Record<ViewEdgeStatus, number>> = {
  designed: 0,
  admitted: 1,
  ungoverned: 2,
  violation: 3,
};

const worse = (a: ViewEdgeStatus, b: ViewEdgeStatus): ViewEdgeStatus =>
  SEVERITY[a] >= SEVERITY[b] ? a : b;

const crumbsOf = (focus: string): ReadonlyArray<string> =>
  focus === "" ? [""] : ["", ...[...ancestorsOf(`${focus}/x`)].reverse()];

// The deepest folder every one of these files is under: `--focus` and a
// pull-request render start here.
export const focusOf = (atlas: Atlas, files: ReadonlyArray<string>): string => {
  const known = new Set(atlas.files.filter((one) => !one.external).map((one) => one.path));
  const folders = files.filter((file) => known.has(file)).map(dirnameOf);
  const [first, ...rest] = folders;
  if (first === undefined) return "";
  let common = first;
  for (const folder of rest) {
    while (!isUnder(folder, common)) common = dirnameOf(common);
  }
  return common;
};

type Unit = {
  readonly node: ViewNode;
  // The folder the unit stands for, when it is one.
  readonly folder: Folder | null;
};

// What every view builder asks the atlas repeatedly, built once per atlas.
export type AtlasIndex = {
  readonly atlas: Atlas;
  readonly fileByPath: ReadonlyMap<string, Atlas["files"][number]>;
  readonly nodeByName: ReadonlyMap<string, Atlas["nodes"][number]>;
  readonly selectors: ReadonlyArray<{
    readonly node: Atlas["nodes"][number];
    readonly matches: RegExp;
  }>;
  readonly nodeDepth: (name: string) => number;
};

export const indexAtlas = (atlas: Atlas): AtlasIndex => {
  const nodeByName = new Map(atlas.nodes.map((one) => [one.name, one]));
  return {
    atlas,
    fileByPath: new Map(atlas.files.map((one) => [one.path, one])),
    nodeByName,
    selectors: atlas.nodes.map((one) => ({ node: one, matches: new RegExp(one.selector) })),
    nodeDepth: (name) => {
      let depth = 0;
      let at = nodeByName.get(name);
      while (at !== undefined && at.parent !== null) {
        depth += 1;
        at = nodeByName.get(at.parent);
      }
      return depth;
    },
  };
};

// What is known about everything beneath a path: its tier, its layer, its
// badges. The one way a view node is made, whichever view it is in.
export const describeNode = (
  index: AtlasIndex,
  id: string,
  kind: ViewNodeKind,
  label: string,
  beneath: ReadonlyArray<string>,
): ViewNode => {
  const { atlas, fileByPath, nodeDepth, selectors } = index;
  const isBeneath = (file: string): boolean =>
    kind === "file" || isExternalTarget(id) ? file === id : isUnder(file, id);
  const governing = selectors
    .filter(({ matches }) => beneath.length > 0 && beneath.every((file) => matches.test(file)))
    .sort((a, b) => nodeDepth(b.node.name) - nodeDepth(a.node.name))[0]?.node;
  const violations = atlas.violations.filter((one) => isBeneath(one.file));
  // The innermost layer every file beneath shares, when they share one.
  const innermost = beneath.map((file) => fileByPath.get(file)?.layers.at(-1)?.id ?? null);
  const layer =
    innermost.length > 0 && innermost.every((one) => one !== null && one === innermost[0])
      ? innermost[0]
      : null;
  return {
    id,
    kind,
    label,
    node: governing?.name ?? null,
    ...(governing?.message === undefined ? {} : { message: governing.message }),
    ...(layer === null || layer === undefined ? {} : { layer }),
    files: beneath.length,
    residue: beneath.filter((file) => {
      const reach = fileByPath.get(file)?.reach;
      return (
        reach !== undefined &&
        !reach.imports &&
        reach.structure !== "enumerated" &&
        !reach.members &&
        !reach.surface &&
        !reach.graph
      );
    }).length,
    badges: {
      violations: violations.filter((one) => !one.baselined).length,
      baselined: violations.filter((one) => one.baselined).length,
      cycles: atlas.cycles.filter((cycle) => cycle.some(isBeneath)).length,
      unrestricted: governing?.unrestricted === true,
      partial: governing?.partial === true,
    },
  };
};

export const viewOf = (
  atlas: Atlas,
  focus: string,
  options: ViewOptions = DEFAULT_VIEW_OPTIONS,
): View => {
  const local = atlas.files.filter((one) => !one.external);
  const index = indexAtlas(atlas);
  const { nodeByName } = index;
  const messageByFingerprint = new Map(
    atlas.violations.map((one) => [one.fingerprint, one.message]),
  );

  const [root] = trieOf(
    local.map((one) => one.path),
    [""],
  );
  if (root === undefined) throw new Error("trieOf returned no root");
  const folder = findFolder([root], focus);
  const crumbs = crumbsOf(focus);
  if (folder === null) return { focus, crumbs, members: [], outside: [], edges: [] };

  const describe = (
    id: string,
    kind: ViewNodeKind,
    label: string,
    beneath: ReadonlyArray<string>,
  ): ViewNode => describeNode(index, id, kind, label, beneath);

  const folderNode = (one: Folder): ViewNode =>
    describe(one.path, "folder", `${one.name}/`, filesBeneath(one));
  const fileNode = (file: string): ViewNode => describe(file, "file", basenameOf(file), [file]);

  // The children of a folder: its subfolders, then its files, each by name.
  const childrenOf = (of: Folder): ReadonlyArray<Unit> => [
    ...[...of.children.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child): Unit => ({ node: folderNode(child), folder: child })),
    ...[...of.files].sort().map((file): Unit => ({ node: fileNode(file), folder: null })),
  ];

  const memberUnits = childrenOf(folder);
  // The units the edges run between: the members, or with `depth: 2` the
  // members' own children where a member is a folder with any.
  const units = new Map<string, Unit>();
  const members: Array<ViewNode> = [];
  for (const member of memberUnits) {
    if (options.depth === 2 && member.folder !== null) {
      const inner = childrenOf(member.folder);
      members.push({ ...member.node, children: inner.map((one) => one.node) });
      for (const one of inner) units.set(one.node.id, one);
    } else {
      members.push(member.node);
      units.set(member.node.id, member);
    }
  }

  // Which unit a path inside the focus falls under: the member (or, at depth
  // 2, the member's child) whose folder holds it, or the file itself.
  const unitInside = (path: string): string | null => {
    for (const [id, unit] of units) {
      if (unit.folder === null ? path === id : isUnder(path, id)) return id;
    }
    return null;
  };

  // Where an edge leaving the focus lands: the nearest sibling of an ancestor
  // of the focus that holds the target — from `a/b/c`, a target in `a/b/d/x`
  // is `../d/` — or the package, or the runtime module. Created on demand.
  const outside = new Map<string, ViewNode>();
  const outsideUnit = (path: string): string => {
    if (outside.has(path)) return path;
    const known = outside.get(path);
    if (known !== undefined) return known.id;
    if (path.startsWith(PACKAGE_PREFIX)) {
      outside.set(path, describe(path, "package", path.slice(PACKAGE_PREFIX.length), [path]));
      return path;
    }
    if (path.startsWith(BUILTIN_PREFIX)) {
      outside.set(path, describe(path, "builtin", path.slice(BUILTIN_PREFIX.length), [path]));
      return path;
    }
    // The ancestors of the focus, nearest first, then the root.
    const ancestors = [...ancestorsOf(focus), ""];
    let ups = 0;
    for (const ancestor of ancestors) {
      ups += 1;
      if (!isUnder(path, ancestor)) continue;
      const rest = ancestor === "" ? path : path.slice(ancestor.length + 1);
      const [segment = rest] = rest.split("/");
      const id = ancestor === "" ? segment : `${ancestor}/${segment}`;
      const isFile = id === path;
      const beneath = isFile
        ? [path]
        : local.map((one) => one.path).filter((file) => isUnder(file, id));
      const label = `${"../".repeat(ups)}${segment}${isFile ? "" : "/"}`;
      if (!outside.has(id)) outside.set(id, describe(id, "outside", label, beneath));
      return id;
    }
    return path;
  };

  const unitOf = (path: string): string | null =>
    isExternalTarget(path) || !isUnder(path, focus)
      ? options.outside === "hide"
        ? null
        : outsideUnit(path)
      : unitInside(path);

  // Roll up: one edge per pair of units, the worst of its parts.
  type Rolled = {
    from: string;
    to: string;
    status: ViewEdgeStatus;
    underlying: Array<AtlasEdge>;
  };
  const rolled = new Map<string, Rolled>();
  for (const edge of atlas.edges) {
    if (!isUnder(edge.from, focus)) continue;
    const from = unitInside(edge.from);
    const to = unitOf(edge.to);
    if (from === null || to === null || from === to) continue;
    const key = `${from} ${to}`;
    const existing = rolled.get(key) ?? { from, to, status: edge.status, underlying: [] };
    existing.status = worse(existing.status, edge.status);
    existing.underlying.push(edge);
    rolled.set(key, existing);
  }

  // A designed edge is an allowance nothing uses — slack — drawn as a ghost
  // where no observed edge already runs: from the files the node selects to
  // the files the entry matches, both rolled up to units. A used allowance
  // draws nothing beyond its traffic: `src/**` at `src/` would otherwise
  // ghost every pair of siblings in every folder beneath it.
  if (options.designed) {
    for (const designed of atlas.designed) {
      if (designed.used) continue;
      const node = nodeByName.get(designed.node);
      if (node === undefined) continue;
      const selects = new RegExp(node.selector);
      const froms = new Set(
        local
          .map((one) => one.path)
          .filter((file) => isUnder(file, focus) && selects.test(file))
          .map(unitInside)
          .filter((one): one is string => one !== null),
      );
      const tos = new Set(
        designed.targets.map(unitOf).filter((one): one is string => one !== null),
      );
      for (const from of froms) {
        for (const to of tos) {
          if (from === to) continue;
          const key = `${from} ${to}`;
          if (!rolled.has(key)) rolled.set(key, { from, to, status: "designed", underlying: [] });
        }
      }
    }
  }

  const edges: ReadonlyArray<ViewEdge> = [...rolled.values()]
    .map((one): ViewEdge => {
      const offending = one.underlying.find((edge) => edge.status === "violation");
      const fingerprint = offending?.violations?.[0];
      return {
        from: one.from,
        to: one.to,
        status: one.status,
        count: one.underlying.length,
        worst:
          fingerprint === undefined
            ? null
            : { fingerprint, message: messageByFingerprint.get(fingerprint) ?? "" },
        underlying: one.underlying,
      };
    })
    .sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));

  // Only the outside nodes some edge reaches.
  const reached = new Set(edges.map((one) => one.to));
  return {
    focus,
    crumbs,
    members,
    outside: [...outside.values()]
      .filter((one) => reached.has(one.id))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges,
  };
};
