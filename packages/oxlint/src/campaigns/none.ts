import type { UninstalledExtension } from "@goodbones/core";

import type { OxlintRule, Program, RuleContext } from "../oxlint-api.js";
import type { CampaignsFamily } from "./host.js";

// The package the family comes in, and the manifest keys it would claim: a
// manifest that uses one without it is refused naming the package, rather
// than as a misspelling.
export const CAMPAIGNS_PACKAGE = "@goodbones/campaigns";

const UNINSTALLED: UninstalledExtension = {
  manifestKeys: ["campaigns", "ledger"],
  install: CAMPAIGNS_PACKAGE,
};

// The `campaigns` rule without the family. oxlint refuses a configuration
// naming a rule the plugin does not register, with no word of why, so the
// rule is registered anyway and says what to install — once per process, on
// the first file, rather than on every file of the run.
export const notInstalledRule = (): OxlintRule => {
  let said = false;
  return {
    meta: {
      type: "problem" as const,
      docs: { description: `the campaigns, which need ${CAMPAIGNS_PACKAGE} installed` },
      schema: [],
    },
    createOnce(context: RuleContext) {
      return {
        before() {
          return !said;
        },
        Program(_node: Program) {
          if (said) return;
          said = true;
          context.report({
            message:
              `architecture/campaigns needs \`${CAMPAIGNS_PACKAGE}\`, which is not installed. ` +
              `Install it beside @goodbones/oxlint, or turn the rule off.`,
            loc: { line: 1, column: 0 },
          });
        },
      };
    },
  };
};

// The family, when it is not installed.
export const campaignsNotInstalled: CampaignsFamily = {
  host: { rule: notInstalledRule },
  compose: (_repoRoot, _configPath, manifest) =>
    Promise.resolve({ manifest, extensions: [], uninstalled: [UNINSTALLED] }),
  prepare: () => Promise.resolve(),
};
