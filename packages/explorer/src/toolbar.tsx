import type { View } from "@goodbones/core";
import type { ReactElement } from "react";

import type { ExplorerState } from "./hash-state.js";

// The crumb bar and the toggles: where the reader is, the way up, and the
// view options the URL carries.

export type ToolbarProps = {
  readonly view: View;
  readonly state: ExplorerState;
  readonly live: boolean;
  readonly busy: boolean;
  readonly onNavigate: (focus: string) => void;
  readonly onChange: (patch: Partial<ExplorerState>) => void;
  readonly onRescan: () => void;
};

const nameOf = (crumb: string): string => {
  if (crumb === "") return "repository";
  const at = crumb.lastIndexOf("/");
  return at === -1 ? crumb : crumb.slice(at + 1);
};

export const Toolbar = (props: ToolbarProps): ReactElement => (
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
      {props.live && (
        <button type="button" onClick={props.onRescan} disabled={props.busy}>
          {props.busy ? "scanning…" : "rescan"}
        </button>
      )}
    </div>
  </header>
);
