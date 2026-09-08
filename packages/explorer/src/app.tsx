import { type Atlas, renderMermaid, type View, viewOf } from "@goodbones/core";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";

import {
  type AtlasSource,
  fetchAtlas,
  type Fetcher,
  INLINE_ATLAS_ID,
  loadAtlas,
} from "./atlas-source.js";
import { Canvas } from "./canvas.js";
import {
  DEFAULT_STATE,
  type ExplorerState,
  parseHash,
  type Selection,
  serializeHash,
} from "./hash-state.js";
import { highlightOf } from "./highlight.js";
import { elkLayout, type Layout, type LayoutEngine } from "./layout.js";
import { type Facts, isFacts, Panel } from "./panel.js";
import { type Hit, searchFiles } from "./search.js";
import { Toolbar } from "./toolbar.js";

// The app: the atlas, once loaded; the state, from the URL hash; the view,
// which is the core's roll-up of the atlas to the focus; and the layout,
// which is ELK's. Every click writes the hash, and the hash is what renders,
// so a view is a link and the back button goes up.

export type AppProps = {
  readonly fetcher?: Fetcher;
  readonly layout?: LayoutEngine;
  // The document's inline atlas, when `explore --out` wrote one in.
  readonly inline?: string | null;
  // Where "copy mermaid" puts the text; the clipboard, unless a test says.
  readonly copy?: (text: string) => Promise<void>;
};

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly source: AtlasSource };

const readHash = (): ExplorerState =>
  typeof window === "undefined" ? DEFAULT_STATE : parseHash(window.location.hash);

const inlineAtlas = (): string | null =>
  typeof document === "undefined"
    ? null
    : (document.getElementById(INLINE_ATLAS_ID)?.textContent ?? null);

const copyToClipboard = (text: string): Promise<void> => navigator.clipboard.writeText(text);

export const App = (props: AppProps): ReactElement => {
  const fetcher: Fetcher = props.fetcher ?? ((url) => fetch(url));
  const layoutEngine = props.layout ?? elkLayout;
  const copy = props.copy ?? copyToClipboard;

  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [state, setState] = useState<ExplorerState>(readHash);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadAtlas(props.inline ?? inlineAtlas(), fetcher)
      .then((source) => {
        if (!cancelled) setLoaded({ kind: "ready", source });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoaded({ kind: "failed", message: String(cause) });
      });
    return () => {
      cancelled = true;
    };
    // The atlas is loaded once; a rescan asks again explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHash = (): void => {
      setState(parseHash(window.location.hash));
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  const change = useCallback(
    (patch: Partial<ExplorerState>) => {
      const next = { ...state, ...patch };
      setState(next);
      if (typeof window !== "undefined") {
        const hash = serializeHash(next);
        if (window.location.hash !== hash) window.location.hash = hash;
      }
    },
    [state],
  );
  const navigate = useCallback(
    (focus: string) => {
      change({ focus, selected: null });
    },
    [change],
  );
  const select = useCallback(
    (selected: Selection | null) => {
      change({ selected });
    },
    [change],
  );

  const atlas: Atlas | null = loaded.kind === "ready" ? loaded.source.atlas : null;
  const view: View | null = useMemo(
    () =>
      atlas === null
        ? null
        : viewOf(atlas, state.focus, {
            depth: state.depth,
            outside: state.outside ? "collapse" : "hide",
            designed: state.designed,
          }),
    [atlas, state.focus, state.depth, state.outside, state.designed],
  );
  const highlight = useMemo(
    () => (atlas === null || view === null ? null : highlightOf(atlas, view, state.selected)),
    [atlas, view, state.selected],
  );

  const [layout, setLayout] = useState<{ readonly view: View; readonly layout: Layout } | null>(
    null,
  );
  useEffect(() => {
    if (view === null) return;
    let cancelled = false;
    layoutEngine(view)
      .then((laid) => {
        if (!cancelled) setLayout({ view, layout: laid });
      })
      .catch(() => {
        if (!cancelled) setLayout(null);
      });
    return () => {
      cancelled = true;
    };
  }, [view, layoutEngine]);

  const rescan = useCallback(() => {
    if (loaded.kind !== "ready" || !loaded.source.live) return;
    setBusy(true);
    fetchAtlas(fetcher)
      .then((fresh) => {
        setLoaded({ kind: "ready", source: { atlas: fresh, live: true } });
      })
      .catch((cause: unknown) => {
        setLoaded({ kind: "failed", message: String(cause) });
      })
      .finally(() => {
        setBusy(false);
      });
  }, [loaded, fetcher]);

  const factsOf = useMemo(
    () =>
      loaded.kind === "ready" && loaded.source.live
        ? async (file: string): Promise<Facts> => {
            const response = await fetcher(`facts?file=${encodeURIComponent(file)}`);
            if (!response.ok) throw new Error("no facts");
            const body: unknown = await response.json();
            if (!isFacts(body)) throw new Error("not facts");
            return body;
          }
        : null,
    [loaded, fetcher],
  );

  const search = useCallback(
    (query: string): ReadonlyArray<Hit> => (atlas === null ? [] : searchFiles(atlas, query)),
    [atlas],
  );
  // A hit opens its folder with the file selected: where `explain` starts.
  const pick = useCallback(
    (hit: Hit) => {
      change({ focus: hit.folder, selected: { kind: "node", id: hit.path } });
    },
    [change],
  );
  const exportMermaid = useCallback(async (): Promise<string> => {
    if (view === null) throw new Error("nothing to export");
    const text = renderMermaid(view);
    await copy(text);
    return text;
  }, [view, copy]);

  if (loaded.kind === "loading") return <main className="status">loading the atlas…</main>;
  if (loaded.kind === "failed") {
    return (
      <main className="status error">
        <h1>could not load the atlas</h1>
        <p>{loaded.message}</p>
      </main>
    );
  }
  if (view === null || atlas === null) return <main className="status">…</main>;

  const empty = view.members.length === 0;
  return (
    <div className="explorer">
      <Toolbar
        view={view}
        state={state}
        live={loaded.source.live}
        busy={busy}
        onNavigate={navigate}
        onChange={change}
        onRescan={rescan}
        onSearch={search}
        onPick={pick}
        onExport={exportMermaid}
      />
      <div className="body">
        <main className="canvas">
          {highlight !== null && <div className="lit-label">{highlight.label}</div>}
          {empty ? (
            <div className="status">
              <p>
                {state.focus === "" ? "the walk" : state.focus} holds no walked file.{" "}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    navigate("");
                  }}
                >
                  back to the repository
                </button>
              </p>
            </div>
          ) : layout === null || layout.view !== view ? (
            <div className="status">laying out…</div>
          ) : (
            <Canvas
              view={view}
              layout={layout.layout}
              selection={state.selected}
              highlight={highlight}
              onNode={(node) => {
                if (node.kind === "folder") navigate(node.id);
                else select({ kind: "node", id: node.id });
              }}
              onEdge={(edge) => {
                select({ kind: "edge", from: edge.from, to: edge.to });
              }}
              onClear={() => {
                select(null);
              }}
            />
          )}
        </main>
        <Panel
          atlas={atlas}
          view={view}
          selection={state.selected}
          highlight={highlight}
          factsOf={factsOf}
          onNavigate={navigate}
          onSelect={select}
        />
      </div>
    </div>
  );
};
