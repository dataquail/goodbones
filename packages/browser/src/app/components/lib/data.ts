import { useEffect, useState } from "react";

// The page's two reads and its one feed, all relative to the page: the bin
// and the Vite plugin answer `__goodbones/*` beside it, and a static export
// has them as files. Where the feed is absent the page is a snapshot.

export type Loaded<T> =
  | { readonly state: "loading"; readonly value: T | null; readonly error: null }
  | { readonly state: "ready"; readonly value: T; readonly error: null }
  | { readonly state: "failed"; readonly value: T | null; readonly error: string };

const urlOf = (route: string): string => new URL(`__goodbones/${route}`, document.baseURI).href;

const errorOf = (body: unknown, status: number): string =>
  typeof body === "object" && body !== null && "error" in body
    ? String(body.error)
    : `HTTP ${String(status)}`;

// `version` bumps when the feed says the repository changed; the value is
// kept while the next one loads, so the page never blanks.
export const useModel = <T>(route: string, version: number): Loaded<T> => {
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: "loading", value: null, error: null });
  useEffect(() => {
    let cancelled = false;
    setLoaded((previous) => ({ state: "loading", value: previous.value, error: null }));
    fetch(urlOf(route), { cache: "no-store" })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setLoaded((previous) => ({
            state: "failed",
            value: previous.value,
            error: errorOf(body, response.status),
          }));
          return;
        }
        setLoaded({ state: "ready", value: body as T, error: null });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoaded((previous) => ({ state: "failed", value: previous.value, error: String(cause) }));
      });
    return () => {
      cancelled = true;
    };
  }, [route, version]);
  return loaded;
};

export type Feed = {
  readonly live: boolean;
  readonly version: number;
  readonly changed: ReadonlyArray<string>;
};

export const useFeed = (): Feed => {
  const [feed, setFeed] = useState<Feed>({ live: false, version: 0, changed: [] });
  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    const events = new EventSource(urlOf("events"));
    events.addEventListener("hello", () => {
      setFeed((previous) => ({ ...previous, live: true }));
    });
    events.addEventListener("changed", (event) => {
      let files: ReadonlyArray<string> = [];
      try {
        const data: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (
          typeof data === "object" &&
          data !== null &&
          "files" in data &&
          Array.isArray(data.files)
        ) {
          files = data.files.map(String);
        }
      } catch {
        files = [];
      }
      setFeed((previous) => ({ live: true, version: previous.version + 1, changed: files }));
    });
    events.addEventListener("error", () => {
      // A static export has no feed: the first error is the last.
      if (events.readyState === EventSource.CLOSED) {
        setFeed((previous) => ({ ...previous, live: false }));
      }
    });
    return () => {
      events.close();
    };
  }, []);
  return feed;
};

// The page's route, in the hash: `#architecture` or `#campaigns`, with a
// selection after a slash (`#architecture/packages/core/src/index.ts`).
export type Route = {
  readonly tab: "architecture" | "campaigns";
  readonly selection: string | null;
};

export const routeOf = (hash: string): Route => {
  const trimmed = hash.replace(/^#/, "");
  const at = trimmed.indexOf("/");
  const tab = at === -1 ? trimmed : trimmed.slice(0, at);
  const selection = at === -1 ? null : decodeURIComponent(trimmed.slice(at + 1));
  return { tab: tab === "campaigns" ? "campaigns" : "architecture", selection };
};

export const hashOf = (route: Route): string =>
  `#${route.tab}${route.selection === null ? "" : `/${encodeURIComponent(route.selection)}`}`;

export const useRoute = (): readonly [Route, (route: Route) => void] => {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.hash));
  useEffect(() => {
    const onChange = (): void => {
      setRoute(routeOf(window.location.hash));
    };
    window.addEventListener("hashchange", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
    };
  }, []);
  return [
    route,
    (next) => {
      const hash = hashOf(next);
      if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
      setRoute(next);
    },
  ];
};
