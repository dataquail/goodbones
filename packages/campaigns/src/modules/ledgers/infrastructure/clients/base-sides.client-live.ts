import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import type { BaseSide } from "../../domain/base-side/base-side.value-object.js";
import type { BaseSidesClient } from "../../domain/ports/clients/base-sides.client.js";

// The exact mode's cache, per commit, under the repository's
// `node_modules/.cache/goodbones/`. A repository with no `node_modules` keeps
// none: the cache is a convenience, never a file the tool leaves behind
// where it would be committed.
export const makeBaseSidesClientLive = (repoRoot: string): BaseSidesClient => {
  const modules = path.join(repoRoot, "node_modules");
  const at = (sha: string): string => path.join(modules, ".cache", "goodbones", `base-${sha}.json`);

  return {
    read: (sha) => {
      if (!existsSync(at(sha))) return null;

      try {
        return JSON.parse(readFileSync(at(sha), "utf8")) as BaseSide;
      } catch {
        // an unreadable cache is recomputed
        return null;
      }
    },
    write: (sha, side) => {
      if (!existsSync(modules)) return;
      mkdirSync(path.dirname(at(sha)), { recursive: true });
      writeFileSync(at(sha), JSON.stringify(side));
    },
  };
};
