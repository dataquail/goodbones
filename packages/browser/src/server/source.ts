import { collect, type Collected, type CollectOptions } from "./collect.js";
import { hostCampaigns } from "./compose.js";
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
  let closed = false;
  if (options.watch === true) {
    const watching = (also: ReadonlyArray<string>, ledgerDir: string): void => {
      if (closed) return;
      stopWatching?.();
      stopWatching = watchRepository({
        repoRoot: options.repoRoot,
        extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
        ledgerDir,
        also,
        debounceMs: options.debounceMs,
        onChange: invalidate,
      });
    };
    // Until the policy has loaded, every change under the roots counts.
    watching([], ".architecture-campaigns");
    void (async () => {
      // A commit redraws too, when the campaigns family is there to say what
      // the working tree's nudge against `HEAD` is.
      const git = (await hostCampaigns()).host.gitPaths(options.repoRoot);
      const also = git === null ? [] : [git.head, git.index];
      watching(also, ".architecture-campaigns");
      // The ledger directory comes from the policy, once it has loaded.
      const collected = await current();
      watching(also, collected.campaigns.ledgerDir);
    })().catch(() => {
      // Keep the watcher there is: the manifest that failed to load is one of
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
      closed = true;
      stopWatching?.();
      listeners.clear();
    },
  };
};
