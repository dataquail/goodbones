import type { FileSystem } from "@goodbones/core";

import type { Commit } from "../../git/commit.value-object.js";
import type { Diff } from "../../git/diff.value-object.js";

// What the verbs read from git about the repository a policy was loaded
// from: the working tree's diff, a file or a whole tree as it was at a ref,
// and the commits that touched some paths. Every member throws where git
// does not answer — no repository, an unknown ref — except `textAt`, for
// which a file absent at the ref is `null`.
export type GitClient = {
  // The working tree against `base` (or HEAD), untracked files included as
  // added whole.
  readonly diff: (base: string | null) => Diff;
  readonly textAt: (ref: string, file: string) => string | null;
  readonly commitOf: (ref: string) => string;
  // The tree at `ref`, materialized in a temporary directory with the
  // repository's `node_modules` linked beside it; the caller disposes of it.
  readonly materializeTree: (ref: string) => {
    readonly root: string;
    readonly dispose: () => void;
  };
  // Oldest first; since `since` when it is given.
  readonly commitsTouching: (
    paths: ReadonlyArray<string>,
    since: string | null,
  ) => ReadonlyArray<Commit>;
  // The tree at `ref`, read as the core reads any file: what the ledgers'
  // repositories are built over to read HEAD's ledgers.
  readonly fileSystemAt: (ref: string) => FileSystem;
};
