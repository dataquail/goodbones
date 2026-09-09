// The viewer's state lives in the URL hash, so a view is a link and the
// browser's back button goes up: `#focus=packages/core/src&depth=2&designed&
// inside&select=edge:a|b`, or `#layer=io`, or `#slice=<file>`. Nothing here
// touches the window; the app reads `location.hash` and hands it in.

export type Selection =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "edge"; readonly from: string; readonly to: string }
  // A violation, by fingerprint: a `reach` one is traced as a route.
  | { readonly kind: "violation"; readonly fingerprint: string }
  // A cycle, by its index in the atlas: its members and the edges within
  // the component light up.
  | { readonly kind: "cycle"; readonly index: number };

// What the canvas is a diagram of: one folder's children, every member of
// one layer, or the vertical slice one file takes part in.
export type Mode =
  | { readonly kind: "folder" }
  | { readonly kind: "layer"; readonly layer: string }
  | { readonly kind: "slice"; readonly file: string };

export type ExplorerState = {
  readonly mode: Mode;
  // The folder, in folder mode; kept across the other modes so the crumbs
  // lead back to it.
  readonly focus: string;
  readonly depth: 1 | 2;
  readonly designed: boolean;
  readonly outside: boolean;
  readonly selected: Selection | null;
};

export const DEFAULT_STATE: ExplorerState = {
  mode: { kind: "folder" },
  focus: "",
  depth: 1,
  designed: false,
  outside: true,
  selected: null,
};

export const selectionKey = (selection: Selection): string => {
  switch (selection.kind) {
    case "node":
      return `node:${selection.id}`;
    case "edge":
      return `edge:${selection.from}|${selection.to}`;
    case "violation":
      return `violation:${selection.fingerprint}`;
    case "cycle":
      return `cycle:${String(selection.index)}`;
  }
};

const parseSelection = (key: string | null): Selection | null => {
  if (key === null) return null;
  if (key.startsWith("node:")) return { kind: "node", id: key.slice("node:".length) };
  if (key.startsWith("edge:")) {
    const at = key.indexOf("|", "edge:".length);
    if (at === -1) return null;
    return { kind: "edge", from: key.slice("edge:".length, at), to: key.slice(at + 1) };
  }
  if (key.startsWith("violation:")) {
    return { kind: "violation", fingerprint: key.slice("violation:".length) };
  }
  if (key.startsWith("cycle:")) {
    const index = Number(key.slice("cycle:".length));
    return Number.isInteger(index) && index >= 0 ? { kind: "cycle", index } : null;
  }
  return null;
};

const parseMode = (params: URLSearchParams): Mode => {
  const layer = params.get("layer");
  if (layer !== null && layer !== "") return { kind: "layer", layer };
  const file = params.get("slice");
  if (file !== null && file !== "") return { kind: "slice", file };
  return { kind: "folder" };
};

export const parseHash = (hash: string): ExplorerState => {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return {
    mode: parseMode(params),
    focus: (params.get("focus") ?? "").replace(/\/+$/, ""),
    depth: params.get("depth") === "2" ? 2 : 1,
    designed: params.has("designed"),
    // Outside is on unless the link says otherwise: the edges leaving a
    // folder are half of what it is.
    outside: !params.has("inside"),
    selected: parseSelection(params.get("select")),
  };
};

export const serializeHash = (state: ExplorerState): string => {
  const params = new URLSearchParams();
  if (state.focus !== "") params.set("focus", state.focus);
  if (state.mode.kind === "layer") params.set("layer", state.mode.layer);
  if (state.mode.kind === "slice") params.set("slice", state.mode.file);
  if (state.depth === 2) params.set("depth", "2");
  if (state.designed) params.set("designed", "");
  if (!state.outside) params.set("inside", "");
  if (state.selected !== null) params.set("select", selectionKey(state.selected));
  const text = params.toString().replaceAll("=&", "&").replace(/=$/, "");
  return text === "" ? "" : `#${text}`;
};
