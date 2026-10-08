import type { UninstalledExtension } from "@goodbones/core";
import * as Effect from "effect/Effect";

import { fail } from "../output.js";
import type { CampaignsFamily, CampaignsHost } from "./host.js";

// The package the family comes in, and the manifest keys it would claim: a
// manifest that uses one without it is refused naming the package, rather
// than as a misspelling.
export const CAMPAIGNS_PACKAGE = "@goodbones/campaigns";

export const CAMPAIGNS_UNINSTALLED: UninstalledExtension = {
  manifestKeys: ["campaigns", "ledger"],
  install: CAMPAIGNS_PACKAGE,
};

const notInstalled = (verb: string) =>
  Effect.fail(
    fail(
      `\`architecture ${verb}\` needs \`${CAMPAIGNS_PACKAGE}\`, which is not installed. ` +
        `Install it beside @goodbones/cli to run campaigns.`,
    ),
  );

// The family, when it is not installed: there is nothing to evaluate, so every
// report has no campaigns in it, and the two campaigns commands say what to
// install.
export const noCampaigns: CampaignsHost = {
  widenedExtensions: () => [],
  readReports: () => Promise.resolve(),
  evaluate: () => [],
  hitsOf: () => [],
  reportsOf: () => [],
  failuresOf: () => [],
  renderReports: () => [],
  snapshotOf: () => [],
  renderRows: () => [],
  explainLines: () => [],
  campaigns: () => notInstalled("campaigns"),
  objectives: () => notInstalled("objectives"),
};

export const campaignsNotInstalled: CampaignsFamily = {
  host: noCampaigns,
  compose: (_repoRoot, _configPath, manifest) =>
    Promise.resolve({ manifest, extensions: [], uninstalled: [CAMPAIGNS_UNINSTALLED] }),
};
