import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

import type { FileSystem } from "../ports/file-system.js";

// One lint run asks about the same sibling many times — every handler in a
// folder resolves the same `../../infrastructure/...` shape — so the answers are
// memoised for the life of the run.
export const makeFileSystemLive = (repoRoot: string): FileSystem => {
  const cache = new Map<string, boolean>();
  return {
    exists: (repoRelativePath) => {
      const cached = cache.get(repoRelativePath);
      if (cached !== undefined) return cached;
      const answer = existsSync(path.resolve(repoRoot, repoRelativePath));
      cache.set(repoRelativePath, answer);
      return answer;
    },
    readText: (repoRelativePath) => {
      try {
        return readFileSync(path.resolve(repoRoot, repoRelativePath), "utf8");
      } catch {
        return null;
      }
    },
    list: (repoRelativeDir) => {
      try {
        return readdirSync(path.resolve(repoRoot, repoRelativeDir)).sort();
      } catch {
        return [];
      }
    },
  };
};
