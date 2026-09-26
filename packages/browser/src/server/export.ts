import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import type { Collected } from "./collect.js";

// A static export: the page as built, with the two models written where the
// page fetches them. Serve the folder from the root of a host; the page
// finds no feed there and says it is a snapshot.
export const exportSite = (siteDir: string, out: string, collected: Collected): void => {
  mkdirSync(out, { recursive: true });
  cpSync(siteDir, out, { recursive: true });
  const data = path.join(out, "__goodbones");
  mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, "atlas.json"), JSON.stringify(collected.atlas));
  writeFileSync(path.join(data, "campaigns.json"), JSON.stringify(collected.campaigns));
  writeFileSync(
    path.join(data, "status.json"),
    JSON.stringify({
      name: collected.atlas.name,
      generatedAt: collected.atlas.generatedAt,
      live: false,
    }),
  );
};
