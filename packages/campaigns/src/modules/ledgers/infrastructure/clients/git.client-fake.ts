import type { FileSystem } from "@goodbones/core";

import type { Commit } from "../../domain/git/commit.value-object.js";
import type { Diff } from "../../domain/git/diff.value-object.js";
import type { GitClient } from "../../domain/ports/clients/git.client.js";

// git as a test states it: the diff, each ref's files by path, and the log.
// It answers where the live client does: a file at a ref the test names no
// files for reads as `null`, and `commitOf`, `materializeTree` and
// `commitsTouching` throw on a ref it does not know, as git refuses one.
export type GitClientFake = GitClient & {
  // The trees `materializeTree` handed out and whether each was disposed.
  readonly materialized: ReadonlyArray<{ readonly ref: string; disposed: boolean }>;
};

export type GitClientFakeState = {
  readonly diff?: Diff;
  readonly refs?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly shas?: Readonly<Record<string, string>>;
  readonly commits?: ReadonlyArray<Commit>;
  // Where `materializeTree` says each ref is materialized.
  readonly trees?: Readonly<Record<string, string>>;
};

const EMPTY_DIFF: Diff = { base: null, touched: new Map(), deleted: [], added: [] };

export const makeGitClientFake = (state: GitClientFakeState = {}): GitClientFake => {
  const materialized: Array<{ ref: string; disposed: boolean }> = [];

  const fileSystemAt = (ref: string): FileSystem => ({
    exists: (file) => state.refs?.[ref]?.[file] !== undefined,
    readText: (file) => state.refs?.[ref]?.[file] ?? null,
    list: (dir) =>
      [
        ...new Set(
          Object.keys(state.refs?.[ref] ?? {}).flatMap((file) =>
            file.startsWith(`${dir}/`) ? [file.slice(dir.length + 1).split("/")[0] ?? ""] : [],
          ),
        ),
      ].sort(),
  });

  return {
    diff: (base) => ({ ...(state.diff ?? EMPTY_DIFF), base }),
    textAt: (ref, file) => state.refs?.[ref]?.[file] ?? null,
    commitOf: (ref) => {
      const sha = state.shas?.[ref];

      if (sha === undefined) throw new Error(`fatal: unknown ref ${ref}`);

      return sha;
    },
    materializeTree: (ref) => {
      const root = state.trees?.[ref];

      if (root === undefined) throw new Error(`fatal: unknown ref ${ref}`);
      const tree = { ref, disposed: false };
      materialized.push(tree);

      return {
        root,
        dispose: () => {
          tree.disposed = true;
        },
      };
    },
    commitsTouching: (paths, since) => {
      const all = state.commits ?? [];
      const at = since === null ? -1 : all.findIndex((one) => one.sha === since);

      if (since !== null && at === -1) throw new Error(`fatal: unknown revision ${since}`);
      const from = at + 1;

      return all
        .slice(from)
        .filter((one) =>
          one.files.some((file) => paths.some((p) => file === p || file.startsWith(`${p}/`))),
        );
    },
    fileSystemAt,
    materialized,
  };
};
