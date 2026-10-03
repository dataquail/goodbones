import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Imports a module by path, as it is on disk now. The module loader keeps a
// module for the life of the process, keyed by its URL — so a host that
// lives long (the browser's server) and imported a manifest, or a campaign's
// function, would answer with the first version it saw until it was
// restarted, and say nothing of it. The file's modification time and size
// in the query make an edited file a new URL, and leave an unchanged one the
// URL it had, and the module the loader already holds.
//
// Only the file named is read fresh. What it imports in turn is cached as
// ever: a change two modules down still needs a restart.
export const importFresh = async (file: string): Promise<unknown> => {
  const url = pathToFileURL(file);
  try {
    const { mtimeMs, size } = statSync(file);
    url.search = `?v=${String(mtimeMs)}-${String(size)}`;
  } catch {
    // A file that is not there fails in the import, with the loader's words.
  }
  const loaded: unknown = await import(url.href);
  return loaded;
};
