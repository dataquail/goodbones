import type { UninstalledExtension } from "@goodbones/core";

import type { CampaignsFamily } from "./host.js";

// The package the family comes in, and the manifest keys it would claim: a
// manifest that uses one without it is refused naming the package, rather
// than as a misspelling.
const UNINSTALLED: UninstalledExtension = {
  manifestKeys: ["campaigns", "ledger"],
  install: "@goodbones/campaigns",
};

// The family, when it is not installed: no campaigns to draw, and a view
// that says so, so the page can say what to install.
export const campaignsNotInstalled: CampaignsFamily = {
  host: {
    widenedExtensions: () => [],
    readReports: () => Promise.resolve(),
    view: (request) => ({
      version: 1,
      name: request.name,
      generatedAt: new Date(request.policy.now).toISOString(),
      installed: false,
      ledgerDir: ".architecture-campaigns",
      campaigns: [],
      nudge: null,
    }),
    gitPaths: () => null,
  },
  compose: (_repoRoot, _configPath, manifest) =>
    Promise.resolve({ manifest, extensions: [], uninstalled: [UNINSTALLED] }),
};
