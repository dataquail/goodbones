import type { WorkspaceProject } from "@goodbones/core";

import type { WorkspaceClient } from "../../domain/ports/clients/workspace.client.js";

// The tree as a test states it, by root: its files, repo-relative, and its
// projects. A root the test names nothing for is empty. The files answered
// are those under one of `roots` with an extension the walk asks for; what
// was asked is kept, in order.
export type WorkspaceClientFake = WorkspaceClient & {
  readonly asked: ReadonlyArray<{ readonly root: string; readonly what: "files" | "projects" }>;
};

export type WorkspaceClientFakeState = {
  readonly files?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly projects?: Readonly<Record<string, ReadonlyArray<WorkspaceProject>>>;
};

const under = (file: string, roots: ReadonlyArray<string>): boolean =>
  roots.some((one) => one === "." || file === one || file.startsWith(`${one}/`));

export const makeWorkspaceClientFake = (
  state: WorkspaceClientFakeState = {},
): WorkspaceClientFake => {
  const asked: Array<{ root: string; what: "files" | "projects" }> = [];

  return {
    sourceFiles: (root, roots, languages, widened) => {
      asked.push({ root, what: "files" });
      const extensions = [...languages.flatMap((one) => one.extensions), ...widened];

      return (state.files?.[root] ?? []).filter(
        (file) => under(file, roots) && extensions.some((one) => file.endsWith(one)),
      );
    },
    projects: (root, roots) => {
      asked.push({ root, what: "projects" });

      return (state.projects?.[root] ?? []).filter((one) => under(one.root, roots));
    },
    asked,
  };
};
