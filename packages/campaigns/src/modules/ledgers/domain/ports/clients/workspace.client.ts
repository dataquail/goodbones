import type { WalkedLanguage, WorkspaceProject } from "@goodbones/core";

// The working tree as a walk reads it: the source files under `roots` of
// `root` with an extension a language walks, or one a campaign widens the
// walk to, and the workspace's projects, for an `nx` perimeter. `root` is
// the repository's, or a base tree git materialized.
export type WorkspaceClient = {
  readonly sourceFiles: (
    root: string,
    roots: ReadonlyArray<string>,
    languages: ReadonlyArray<WalkedLanguage>,
    widened: ReadonlyArray<string>,
  ) => ReadonlyArray<string>;
  readonly projects: (
    root: string,
    roots: ReadonlyArray<string>,
  ) => ReadonlyArray<WorkspaceProject>;
};
