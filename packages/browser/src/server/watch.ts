import { type FSWatcher, watch } from "node:fs";
import * as path from "node:path";

// The repository, watched: a change to a source file, a manifest or a ledger
// is what redraws the browsers — and a commit, which changes none of those
// and still changes what the working tree is compared to. Node's recursive watcher, so no dependency;
// events are debounced, since an editor's save is several of them.

const IGNORED = ["node_modules", ".git", "build", "dist", ".nx", ".astro", "coverage"];

export type WatchOptions = {
  readonly repoRoot: string;
  // File extensions that count as source, with their dots.
  readonly extensions: ReadonlyArray<string>;
  // Repo-relative directory of the ledgers.
  readonly ledgerDir: string;
  // Files outside what the walk sees whose change still redraws, absolute:
  // git's `HEAD` and index, which a commit moves and nothing else does.
  readonly also?: ReadonlyArray<string> | undefined;
  readonly debounceMs?: number | undefined;
  readonly onChange: (files: ReadonlyArray<string>) => void;
};

const MANIFEST = /(^|\/)architecture(\.config)?\.(ya?ml|json|mjs)$/;

export const isRelevant = (
  file: string,
  extensions: ReadonlyArray<string>,
  ledgerDir: string,
): boolean => {
  const segments = file.split("/");
  if (segments.some((segment) => IGNORED.includes(segment))) return false;
  if (MANIFEST.test(file)) return true;
  if (ledgerDir !== "" && (file === ledgerDir || file.startsWith(`${ledgerDir}/`))) return true;
  return extensions.includes(path.extname(file));
};

export const watchRepository = (options: WatchOptions): (() => void) => {
  const delay = options.debounceMs ?? 150;
  let pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  const flush = (): void => {
    timer = null;
    const files = [...pending].sort();
    pending = new Set();
    if (files.length > 0) options.onChange(files);
  };
  const changed = (file: string): void => {
    pending.add(file);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, delay);
  };
  const watchers: Array<FSWatcher> = [];
  const quietly = (start: () => FSWatcher): void => {
    try {
      const watcher = start();
      watcher.on("error", () => {
        // A watcher that dies leaves the page static; the next request still
        // recomputes, so nothing is wrong, only not live.
      });
      watchers.push(watcher);
    } catch {
      // Not watchable here: the same.
    }
  };
  quietly(() =>
    watch(options.repoRoot, { recursive: true }, (_event, filename) => {
      if (filename === null) return;
      const file = String(filename).split(path.sep).join("/");
      if (isRelevant(file, options.extensions, options.ledgerDir)) changed(file);
    }),
  );
  // Each extra file by its folder, since git replaces `HEAD` and the index
  // by renaming a lock file over them, and a watch on the file itself would
  // be left holding the one that was replaced.
  const folders = new Map<string, Set<string>>();
  for (const file of options.also ?? []) {
    const folder = path.dirname(file);
    folders.set(folder, new Set([...(folders.get(folder) ?? []), path.basename(file)]));
  }
  for (const [folder, names] of folders) {
    quietly(() =>
      watch(folder, (_event, filename) => {
        if (filename !== null && names.has(String(filename))) {
          changed(path.join(folder, String(filename)));
        }
      }),
    );
  }
  return () => {
    if (timer !== null) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
};
