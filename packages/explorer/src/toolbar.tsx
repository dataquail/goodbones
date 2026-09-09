import type { ArchitecturalLayer, View } from "@goodbones/core";
import { LAYER_FOCUS, SLICE_FOCUS } from "@goodbones/core";
import { type ReactElement, useState } from "react";

import type { ExplorerState, Mode } from "./hash-state.js";
import type { Hit } from "./search.js";

// The crumb bar and the toggles: where the reader is, the way up, the view
// options the URL carries, which layer to look at, a search by path, and the
// mermaid of the view.

export type ToolbarProps = {
  readonly view: View;
  readonly state: ExplorerState;
  readonly layers: ReadonlyArray<ArchitecturalLayer>;
  readonly live: boolean;
  readonly busy: boolean;
  readonly onNavigate: (focus: string) => void;
  readonly onMode: (mode: Mode) => void;
  readonly onChange: (patch: Partial<ExplorerState>) => void;
  readonly onRescan: () => void;
  readonly onSearch: (query: string) => ReadonlyArray<Hit>;
  readonly onPick: (hit: Hit) => void;
  // Copies the mermaid of the current view; resolves to what was copied.
  readonly onExport: () => Promise<string>;
};

// What a crumb is called: the folder's last segment, or the view it names.
export const crumbNameOf = (crumb: string): string => {
  if (crumb === "") return "repository";
  if (crumb.startsWith(LAYER_FOCUS)) return `layer ${crumb.slice(LAYER_FOCUS.length)}`;
  if (crumb.startsWith(SLICE_FOCUS)) {
    const file = crumb.slice(SLICE_FOCUS.length);
    return `slice of ${file.slice(file.lastIndexOf("/") + 1)}`;
  }
  const at = crumb.lastIndexOf("/");
  return at === -1 ? crumb : crumb.slice(at + 1);
};

const modeValue = (mode: Mode): string =>
  mode.kind === "layer"
    ? `${LAYER_FOCUS}${mode.layer}`
    : mode.kind === "slice"
      ? "slice"
      : "folders";

export const Toolbar = (props: ToolbarProps): ReactElement => {
  const [query, setQuery] = useState("");
  const [exported, setExported] = useState<"idle" | "copied" | "failed">("idle");
  const hits = props.onSearch(query);
  const pick = (hit: Hit): void => {
    setQuery("");
    props.onPick(hit);
  };
  const isFolder = (crumb: string): boolean =>
    !crumb.startsWith(LAYER_FOCUS) && !crumb.startsWith(SLICE_FOCUS);
  return (
    <header className="toolbar">
      <nav className="crumbs" aria-label="folders">
        {props.view.crumbs.map((crumb, index) => (
          <span key={crumb === "" ? "/" : crumb}>
            {index > 0 && <span className="sep">/</span>}
            {index === props.view.crumbs.length - 1 || !isFolder(crumb) ? (
              <span className="current" title={crumb}>
                {crumbNameOf(crumb)}
              </span>
            ) : (
              <button
                type="button"
                className="link"
                onClick={() => {
                  props.onNavigate(crumb);
                }}
              >
                {crumbNameOf(crumb)}
              </button>
            )}
          </span>
        ))}
      </nav>
      <div className="search">
        <input
          type="search"
          placeholder="find a file by path"
          aria-label="find a file by path"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            const [first] = hits;
            if (event.key === "Enter" && first !== undefined) pick(first);
            if (event.key === "Escape") setQuery("");
          }}
        />
        {query.trim() !== "" && (
          <ul className="hits" role="listbox">
            {hits.length === 0 && <li className="muted">no walked file matches</li>}
            {hits.map((hit) => (
              <li key={hit.path}>
                <button
                  type="button"
                  className="link"
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    pick(hit);
                  }}
                >
                  {hit.path}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="controls">
        {props.layers.length > 0 && (
          <label>
            view
            <select
              aria-label="view"
              value={modeValue(props.state.mode)}
              onChange={(event) => {
                const value = event.target.value;
                if (value.startsWith(LAYER_FOCUS)) {
                  props.onMode({ kind: "layer", layer: value.slice(LAYER_FOCUS.length) });
                } else if (value === "folders") {
                  props.onMode({ kind: "folder" });
                }
              }}
            >
              <option value="folders">folders</option>
              {props.layers.map((layer) => (
                <option key={layer.id} value={`${LAYER_FOCUS}${layer.id}`}>
                  layer: {layer.id}
                  {layer.type === "enclosing" ? " (enclosing)" : ""}
                </option>
              ))}
              {props.state.mode.kind === "slice" && <option value="slice">slice</option>}
            </select>
          </label>
        )}
        {props.state.mode.kind === "folder" && (
          <label>
            depth
            <select
              value={String(props.state.depth)}
              onChange={(event) => {
                props.onChange({ depth: event.target.value === "2" ? 2 : 1 });
              }}
            >
              <option value="1">1</option>
              <option value="2">2</option>
            </select>
          </label>
        )}
        {props.state.mode.kind === "folder" && (
          <label>
            <input
              type="checkbox"
              checked={props.state.outside}
              onChange={(event) => {
                props.onChange({ outside: event.target.checked });
              }}
            />
            outside
          </label>
        )}
        {props.state.mode.kind === "folder" && (
          <label>
            <input
              type="checkbox"
              checked={props.state.designed}
              onChange={(event) => {
                props.onChange({ designed: event.target.checked });
              }}
            />
            designed
          </label>
        )}
        <button
          type="button"
          title="copy this view as a mermaid flowchart, as `architecture diagram` prints it"
          onClick={() => {
            props
              .onExport()
              .then(() => {
                setExported("copied");
              })
              .catch(() => {
                setExported("failed");
              })
              .finally(() => {
                setTimeout(() => {
                  setExported("idle");
                }, 1600);
              });
          }}
        >
          {exported === "copied"
            ? "copied"
            : exported === "failed"
              ? "could not copy"
              : "copy mermaid"}
        </button>
        {props.live && (
          <button type="button" onClick={props.onRescan} disabled={props.busy}>
            {props.busy ? "scanning…" : "rescan"}
          </button>
        )}
      </div>
    </header>
  );
};
