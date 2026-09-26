import { useEffect, useState } from "react";

import type { Atlas } from "../../model/atlas.js";
import type { CampaignView } from "../../model/campaigns.js";
import { ArchitectureBrowser } from "./architecture/ArchitectureBrowser.js";
import { CampaignBrowser } from "./campaigns/CampaignBrowser.js";
import { useFeed, useModel, useRoute } from "./lib/data.js";

// The page: two browsers under one bar. The bar says which repository, how
// fresh the drawing is and whether it will redraw on its own; the hash says
// which browser is open and what is selected, so a view is a link.

type Theme = "dark" | "light";

const storedTheme = (): Theme | null => {
  try {
    const held = window.localStorage.getItem("goodbones-theme");
    return held === "dark" || held === "light" ? held : null;
  } catch {
    return null;
  }
};

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
};

export const Browser = (): React.JSX.Element => {
  const [route, setRoute] = useRoute();
  const feed = useFeed();
  const atlas = useModel<Atlas>("atlas.json", feed.version);
  const campaigns = useModel<CampaignView>("campaigns.json", feed.version);
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("goodbones-theme", theme);
    } catch {
      // A private window keeps no preference; the page still renders.
    }
  }, [theme]);

  const name = atlas.value?.name ?? campaigns.value?.name ?? "";
  const generatedAt = atlas.value?.generatedAt ?? campaigns.value?.generatedAt ?? null;
  const error = atlas.error ?? campaigns.error;
  const loading = atlas.state === "loading" || campaigns.state === "loading";

  return (
    <div className="page">
      <header className="bar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <span className="brand-name">goodbones</span>
          {name !== "" ? <span className="repo">{name}</span> : null}
        </div>
        <nav className="tabs" aria-label="Browsers">
          <button
            type="button"
            className={route.tab === "architecture" ? "tab active" : "tab"}
            onClick={() => {
              setRoute({ tab: "architecture", selection: null });
            }}
          >
            Architecture Browser
          </button>
          <button
            type="button"
            className={route.tab === "campaigns" ? "tab active" : "tab"}
            onClick={() => {
              setRoute({ tab: "campaigns", selection: null });
            }}
          >
            Campaign Browser
            {campaigns.value !== null && campaigns.value.campaigns.length > 0 ? (
              <span className="count">{campaigns.value.campaigns.length}</span>
            ) : null}
          </button>
        </nav>
        <div className="status">
          <span
            className={`live ${feed.live ? "on" : "off"}`}
            title={
              feed.live
                ? "Live: the page redraws when the repository changes."
                : "A snapshot: no feed of changes is reachable."
            }
          >
            <span className="dot" aria-hidden="true" />
            {feed.live ? "live" : "snapshot"}
          </span>
          {generatedAt !== null ? (
            <span className="stamp" title={generatedAt}>
              {loading ? "redrawing…" : `drawn ${formatTime(generatedAt)}`}
            </span>
          ) : null}
          <button
            type="button"
            className="theme"
            onClick={() => {
              setTheme(theme === "dark" ? "light" : "dark");
            }}
            aria-label="Toggle light and dark"
            title="Toggle light and dark"
          >
            {theme === "dark" ? "☾" : "☀"}
          </button>
        </div>
      </header>
      {error !== null ? (
        <div className="banner error" role="alert">
          <strong>The repository could not be read.</strong> {error}
          {atlas.value !== null ? " Showing the last drawing." : ""}
        </div>
      ) : null}
      {feed.changed.length > 0 && loading ? (
        <div className="banner">
          Changed: {feed.changed.slice(0, 4).join(", ")}
          {feed.changed.length > 4 ? ` and ${String(feed.changed.length - 4)} more` : ""}
        </div>
      ) : null}
      <main className="body">
        {route.tab === "architecture" ? (
          atlas.value === null ? (
            <Placeholder loading={atlas.state === "loading"} what="the architecture" />
          ) : (
            <ArchitectureBrowser
              atlas={atlas.value}
              selection={route.selection}
              onSelect={(selection) => {
                setRoute({ tab: "architecture", selection });
              }}
            />
          )
        ) : campaigns.value === null ? (
          <Placeholder loading={campaigns.state === "loading"} what="the campaigns" />
        ) : (
          <CampaignBrowser
            view={campaigns.value}
            selection={route.selection}
            onSelect={(selection) => {
              setRoute({ tab: "campaigns", selection });
            }}
          />
        )}
      </main>
    </div>
  );
};

const Placeholder = ({ loading, what }: { loading: boolean; what: string }): React.JSX.Element => (
  <div className="placeholder">{loading ? `Reading ${what}…` : `Nothing to draw for ${what}.`}</div>
);
