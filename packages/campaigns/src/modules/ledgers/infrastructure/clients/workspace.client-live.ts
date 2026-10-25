import { listSourceFiles, listWorkspaceProjects } from "@goodbones/core";

import type { WorkspaceClient } from "../../domain/ports/clients/workspace.client.js";

// The core's walker, over the disk.
export const makeWorkspaceClientLive = (): WorkspaceClient => ({
  sourceFiles: (root, roots, languages, widened) =>
    listSourceFiles(root, roots, languages, widened),
  projects: (root, roots) => listWorkspaceProjects(root, roots),
});
