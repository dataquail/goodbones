import type { FileSystem } from "@goodbones/core";

import type { Commit } from "../../domain/git/commit.value-object.js";
import type { Diff } from "../../domain/git/diff.value-object.js";
import type { GitClient } from "../../domain/ports/clients/git.client.js";

// git as a test states it: the diff, each ref's files by path, and the log.
// A ref the test names no files for is unknown, and asking after it throws,
// as git would refuse it.
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

  const filesAt = (ref: string): Readonly<Record<string, string>> => {
    const files = state.refs?.[ref];

    if (files === undefined) throw new Error(`fatal: unknown ref ${ref}`);

    return files;
  };

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
    textAt: (ref, file) => filesAt(ref)[file] ?? null,
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
      const from = since === null ? 0 : all.findIndex((one) => one.sha === since) + 1;

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
