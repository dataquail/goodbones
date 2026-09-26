import { collect, type Collected, type CollectOptions } from "./collect.js";
import { watchRepository } from "./watch.js";

// What the handler serves: the two models, computed once and kept until the
// repository changes, and a feed of those changes for the page to refetch on.

export type Change = { readonly files: ReadonlyArray<string>; readonly at: string };

export type Source = {
  readonly current: () => Promise<Collected>;
  readonly subscribe: (listener: (change: Change) => void) => () => void;
  readonly invalidate: (files: ReadonlyArray<string>) => void;
  readonly live: boolean;
  readonly close: () => void;
};

export type SourceOptions = CollectOptions & {
  readonly watch?: boolean | undefined;
  readonly debounceMs?: number | undefined;
  // For tests: what to compute instead of walking the repository.
  readonly compute?: (() => Promise<Collected>) | undefined;
};

export const makeSource = (options: SourceOptions): Source => {
  const listeners = new Set<(change: Change) => void>();
  let cached: Promise<Collected> | null = null;
  const compute = options.compute ?? (() => collect(options));

  const current = (): Promise<Collected> => {
    if (cached === null) {
      const started = compute();
      cached = started;
      // A failed computation is not kept: the next request tries again,
      // after the author has fixed the manifest.
      started.catch(() => {
        if (cached === started) cached = null;
      });
    }
    return cached;
  };

  const invalidate = (files: ReadonlyArray<string>): void => {
    cached = null;
    const change: Change = { files, at: new Date().toISOString() };
    for (const listener of listeners) listener(change);
  };

  let stopWatching: (() => void) | null = null;
  if (options.watch === true) {
    // The extensions and the ledger directory come from the policy, once it
    // has loaded; until then every change under the roots counts.
    stopWatching = watchRepository({
      repoRoot: options.repoRoot,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
      ledgerDir: ".architecture-campaigns",
      debounceMs: options.debounceMs,
      onChange: invalidate,
    });
    void current()
      .then((collected) => {
        stopWatching?.();
        stopWatching = watchRepository({
          repoRoot: options.repoRoot,
          extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
          ledgerDir: collected.campaigns.ledgerDir,
          debounceMs: options.debounceMs,
          onChange: invalidate,
        });
      })
      .catch(() => {
        // Keep the first watcher: the manifest that failed to load is one of
        // the files it watches, and its fix is the next change.
      });
  }

  return {
    current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidate,
    live: options.watch === true,
    close: () => {
      stopWatching?.();
      listeners.clear();
    },
  };
};
