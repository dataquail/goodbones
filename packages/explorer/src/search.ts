import type { Atlas } from "@goodbones/core";
import { dirnameOf } from "@goodbones/core";

// Search by path. A hit is a walked file; picking one moves the focus to its
// folder with the file selected, which is where `explain` would start.

export type Hit = {
  readonly path: string;
  readonly folder: string;
};

export const MAX_HITS = 12;

// Every walked file whose path holds the query, case-insensitively, the
// shortest paths first so `imports.ts` beats `imports.test.ts` and a file
// beats the folder of files named after it.
export const searchFiles = (atlas: Atlas, query: string): ReadonlyArray<Hit> => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  return atlas.files
    .filter((one) => !one.external && one.path.toLowerCase().includes(needle))
    .map((one) => one.path)
    .sort((a, b) => (a.length === b.length ? a.localeCompare(b) : a.length - b.length))
    .slice(0, MAX_HITS)
    .map((path) => ({ path, folder: dirnameOf(path) }));
};
