import type { Atlas, AtlasEdge, LayerMembership } from "../domain/atlas.js";
import { basenameOf } from "../domain/tree.js";
import {
  type AtlasIndex,
  describeNode,
  indexAtlas,
  type View,
  type ViewEdge,
  type ViewNode,
} from "./view.js";

// Two more ways to look at the atlas, both by layer rather than by folder.
// The folder tree says where a file is; its layer chain says what role it
// plays, and at which folder — `module` at the module, `application` at its
// `commands/`. A layer view is every member of one layer, grouped by the
// enclosing member each sits inside. A slice is the vertical cut through
// the layers one file takes part in: what reaches it from outside, and what
// it reaches inside. Both are `View`s, so the canvas and the mermaid
// renderer draw them the way they draw a folder.

const EXTERNAL_KINDS = new Set(["package", "builtin"]);

// The outermost `enclosing` membership of a file, when it has one.
const enclosingOf = (
  index: AtlasIndex,
  chain: ReadonlyArray<LayerMembership>,
): LayerMembership | null => {
  const types = new Map(index.atlas.layers.map((one) => [one.id, one.type]));
  return chain.find((one) => types.get(one.id) === "enclosing") ?? null;
};

// The innermost `tier` membership of a file, when it has one.
const tierOf = (
  index: AtlasIndex,
  chain: ReadonlyArray<LayerMembership>,
): LayerMembership | null => {
  const types = new Map(index.atlas.layers.map((one) => [one.id, one.type]));
  return [...chain].reverse().find((one) => (types.get(one.id) ?? "tier") === "tier") ?? null;
};

// Where a layer stands, outermost first; an undeclared one is innermost.
const rankOf = (atlas: Atlas, id: string): number => {
  const at = atlas.layers.findIndex((one) => one.id === id);
  return at === -1 ? atlas.layers.length : at;
};

const edgesAmong = (
  atlas: Atlas,
  unitOf: (path: string) => string | null,
  keep: (edge: AtlasEdge) => boolean,
): ReadonlyArray<ViewEdge> => {
  const rolled = new Map<
    string,
    { from: string; to: string; status: ViewEdge["status"]; underlying: Array<AtlasEdge> }
  >();
  const severity = { designed: 0, admitted: 1, ungoverned: 2, violation: 3 } as const;
  const messages = new Map(atlas.violations.map((one) => [one.fingerprint, one.message]));
  for (const edge of atlas.edges) {
    if (!keep(edge)) continue;
    const from = unitOf(edge.from);
    const to = unitOf(edge.to);
    if (from === null || to === null || from === to) continue;
    const key = `${from} ${to}`;
    const existing = rolled.get(key) ?? { from, to, status: edge.status, underlying: [] };
    if (severity[edge.status] > severity[existing.status]) existing.status = edge.status;
    existing.underlying.push(edge);
    rolled.set(key, existing);
  }
  return [...rolled.values()]
    .map((one): ViewEdge => {
      const fingerprint = one.underlying.find((edge) => edge.status === "violation")
        ?.violations?.[0];
      return {
        from: one.from,
        to: one.to,
        status: one.status,
        count: one.underlying.length,
        worst:
          fingerprint === undefined
            ? null
            : { fingerprint, message: messages.get(fingerprint) ?? "" },
        underlying: one.underlying,
      };
    })
    .sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));
};

// The id a layer view or a slice carries as its focus, so the hash and the
// crumbs can name it. Never a folder path: neither starts with a letter a
// path could be confused with.
export const LAYER_FOCUS = "layer:";
export const SLICE_FOCUS = "slice:";

// Every member of one layer. For an `enclosing` layer the members are the
// folders it was assigned at — one node per module, edges rolled up between
// them. For a `tier`, the members are its files, grouped by the enclosing
// member each sits inside (or by "elsewhere"), with the edges between them.
export const layerViewOf = (atlas: Atlas, layerId: string): View => {
  const index = indexAtlas(atlas);
  const focus = `${LAYER_FOCUS}${layerId}`;
  const crumbs = ["", focus];
  const layer = atlas.layers.find((one) => one.id === layerId);
  if (layer === undefined) return { focus, crumbs, members: [], outside: [], edges: [] };
  const local = atlas.files.filter((one) => !one.external);

  if (layer.type === "enclosing") {
    const anchors = new Map<string, Array<string>>();
    for (const file of local) {
      const membership = file.layers.find((one) => one.id === layerId);
      if (membership === undefined) continue;
      const beneath = anchors.get(membership.anchor) ?? [];
      beneath.push(file.path);
      anchors.set(membership.anchor, beneath);
    }
    const anchorOf = new Map<string, string>();
    for (const [anchor, beneath] of anchors) for (const file of beneath) anchorOf.set(file, anchor);
    const members = [...anchors.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([anchor, beneath]) =>
        describeNode(index, anchor, "folder", `${basenameOf(anchor)}/`, beneath),
      );
    const unitOf = (path: string): string | null => anchorOf.get(path) ?? null;
    return { focus, crumbs, members, outside: [], edges: edgesAmong(atlas, unitOf, () => true) };
  }

  // A tier: its files, grouped by their enclosing member.
  const groups = new Map<string, { label: string; files: Array<string> }>();
  const inLayer = new Set<string>();
  for (const file of local) {
    const tier = tierOf(index, file.layers);
    if (tier?.id !== layerId) continue;
    inLayer.add(file.path);
    const enclosing = enclosingOf(index, file.layers);
    const key = enclosing?.anchor ?? "";
    const group = groups.get(key) ?? {
      label: enclosing === null ? "elsewhere" : `${basenameOf(enclosing.anchor)}/`,
      files: [],
    };
    group.files.push(file.path);
    groups.set(key, group);
  }
  // Enclosing members by name; the files outside any enclosing layer last.
  const members = [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([anchor, group]): ViewNode => {
      const id = anchor === "" ? `${focus}/elsewhere` : anchor;
      return {
        ...describeNode(index, id, "folder", group.label, group.files),
        children: [...group.files]
          .sort()
          .map((file) => describeNode(index, file, "file", basenameOf(file), [file])),
      };
    });
  const unitOf = (path: string): string | null => (inLayer.has(path) ? path : null);
  return { focus, crumbs, members, outside: [], edges: edgesAmong(atlas, unitOf, () => true) };
};

// The vertical slice one file takes part in: the files that reach it from an
// outer or equal layer, transitively, and the files it reaches in an inner or
// equal layer, transitively — the endpoint above a handler, the domain below
// it — never stepping through a file no layer claims. Exhaustive on purpose:
// a file dozens of slices pass through shows all of them. Members are the
// enclosing members the slice crosses, each holding one group per layer, in
// layer order; files outside any enclosing layer sit in a group per layer at
// the top.
export const sliceOf = (atlas: Atlas, file: string): View => {
  const index = indexAtlas(atlas);
  const focus = `${SLICE_FOCUS}${file}`;
  const crumbs = ["", focus];
  const origin = index.fileByPath.get(file);
  if (origin === undefined || origin.external || origin.layers.length === 0) {
    return { focus, crumbs, members: [], outside: [], edges: [] };
  }

  const rank = (path: string): number | null => {
    const chain = index.fileByPath.get(path)?.layers;
    const innermost = chain?.at(-1);
    return innermost === undefined ? null : rankOf(atlas, innermost.id);
  };
  // An edge that goes inward, or stays in its layer.
  const inward = (edge: AtlasEdge): boolean => {
    const from = rank(edge.from);
    const to = rank(edge.to);
    return from !== null && to !== null && from <= to;
  };
  const outOf = new Map<string, Array<string>>();
  const into = new Map<string, Array<string>>();
  for (const edge of atlas.edges) {
    if (!inward(edge)) continue;
    outOf.set(edge.from, [...(outOf.get(edge.from) ?? []), edge.to]);
    into.set(edge.to, [...(into.get(edge.to) ?? []), edge.from]);
  }
  const reachable = (
    from: string,
    next: ReadonlyMap<string, ReadonlyArray<string>>,
  ): Set<string> => {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length > 0) {
      const at = queue.shift();
      if (at === undefined) break;
      for (const step of next.get(at) ?? []) {
        if (seen.has(step)) continue;
        seen.add(step);
        queue.push(step);
      }
    }
    return seen;
  };
  const slice = new Set([...reachable(file, into), ...reachable(file, outOf)]);

  // Grouped: enclosing member → layer → files, or layer → files outside any.
  type LayerGroup = { readonly id: string; readonly layer: string; readonly files: Array<string> };
  type EnclosingGroup = { readonly anchor: string; readonly layers: Map<string, LayerGroup> };
  const enclosed = new Map<string, EnclosingGroup>();
  const loose = new Map<string, LayerGroup>();
  for (const path of [...slice].sort()) {
    const chain = index.fileByPath.get(path)?.layers ?? [];
    const innermost = chain.at(-1);
    if (innermost === undefined) continue;
    // A file in an enclosing layer's own files — a module's barrel — is that
    // layer's group inside the box, at the top of it.
    const enclosing = enclosingOf(index, chain);
    if (enclosing !== null) {
      const group = enclosed.get(enclosing.anchor) ?? {
        anchor: enclosing.anchor,
        layers: new Map<string, LayerGroup>(),
      };
      const byLayer = group.layers.get(innermost.id) ?? {
        id: `${enclosing.anchor}::${innermost.id}`,
        layer: innermost.id,
        files: [],
      };
      byLayer.files.push(path);
      group.layers.set(innermost.id, byLayer);
      enclosed.set(enclosing.anchor, group);
    } else {
      const byLayer = loose.get(innermost.id) ?? {
        id: `${LAYER_FOCUS}${innermost.id}`,
        layer: innermost.id,
        files: [],
      };
      byLayer.files.push(path);
      loose.set(innermost.id, byLayer);
    }
  }
  const layerNode = (group: LayerGroup): ViewNode => ({
    ...describeNode(index, group.id, "folder", group.layer, group.files),
    layer: group.layer,
    children: group.files.map((path) =>
      describeNode(index, path, "file", basenameOf(path), [path]),
    ),
  });
  const byRank = (a: LayerGroup, b: LayerGroup): number =>
    rankOf(atlas, a.layer) - rankOf(atlas, b.layer);
  const members: Array<ViewNode> = [
    ...[...enclosed.values()]
      .sort((a, b) => a.anchor.localeCompare(b.anchor))
      .map((group): ViewNode => {
        const files = [...group.layers.values()].flatMap((one) => one.files);
        return {
          ...describeNode(index, group.anchor, "folder", `${basenameOf(group.anchor)}/`, files),
          children: [...group.layers.values()].sort(byRank).map(layerNode),
        };
      }),
    ...[...loose.values()].sort(byRank).map(layerNode),
  ];
  const unitOf = (path: string): string | null =>
    slice.has(path) &&
    !EXTERNAL_KINDS.has(index.fileByPath.get(path)?.external === true ? "package" : "")
      ? path
      : null;
  return { focus, crumbs, members, outside: [], edges: edgesAmong(atlas, unitOf, inward) };
};

// The layer views and slices a file offers, for a panel to list.
export const layerChainOf = (atlas: Atlas, file: string): ReadonlyArray<LayerMembership> =>
  atlas.files.find((one) => one.path === file)?.layers ?? [];
