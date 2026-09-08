import type { View } from "@goodbones/core";
import { type ReactElement, useState } from "react";

import type { ExplorerState } from "./hash-state.js";
import type { Hit } from "./search.js";

// The crumb bar and the toggles: where the reader is, the way up, the view
// options the URL carries, a search by path, and the mermaid of the view.

export type ToolbarProps = {
  readonly view: View;
  readonly state: ExplorerState;
  readonly live: boolean;
  readonly busy: boolean;
  readonly onNavigate: (focus: string) => void;
  readonly onChange: (patch: Partial<ExplorerState>) => void;
  readonly onRescan: () => void;
  readonly onSearch: (query: string) => ReadonlyArray<Hit>;
  readonly onPick: (hit: Hit) => void;
  // Copies the mermaid of the current view; resolves to what was copied.
  readonly onExport: () => Promise<string>;
};

const nameOf = (crumb: string): string => {
  if (crumb === "") return "repository";
  const at = crumb.lastIndexOf("/");
  return at === -1 ? crumb : crumb.slice(at + 1);
};

export const Toolbar = (props: ToolbarProps): ReactElement => {
  const [query, setQuery] = useState("");
  const [exported, setExported] = useState<"idle" | "copied" | "failed">("idle");
  const hits = props.onSearch(query);
  const pick = (hit: Hit): void => {
    setQuery("");
    props.onPick(hit);
  };
  return (
    <header className="toolbar">
      <nav className="crumbs" aria-label="folders">
        {props.view.crumbs.map((crumb, index) => (
          <span key={crumb === "" ? "/" : crumb}>
            {index > 0 && <span className="sep">/</span>}
            {index === props.view.crumbs.length - 1 ? (
              <span className="current">{nameOf(crumb)}</span>
            ) : (
              <button
                type="button"
                className="link"
                onClick={() => {
                  props.onNavigate(crumb);
                }}
              >
                {nameOf(crumb)}
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
