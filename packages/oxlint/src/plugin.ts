import { makeCampaignsRule } from "./campaigns-rule.js";
import { discoverSectorIndexes, loadPolicyFromFile } from "./config-loader.js";
import { makeExportsRule } from "./exports-rule.js";
import { makeImportsRule } from "./imports-rule.js";
import { makeMembersRule } from "./members-rule.js";
import type { OxlintRule } from "./oxlint-api.js";
import { makeStructureRule } from "./structure-rule.js";
import { makeSurfaceRule } from "./surface-rule.js";

// oxlint imports this module once per lint run and reads `rules` synchronously,
// so the policy is loaded here rather than inside a rule. A load failure throws
// out of the import and fails the run — which is the point: a plugin that came
// up with no policy would report nothing and be indistinguishable from a clean
// codebase.
const policy = await loadPolicyFromFile(
  process.env.ARCHITECTURE_ROOT ?? process.cwd(),
  process.env.ARCHITECTURE_CONFIG,
);

// A manifest written in a shape on its way out still loads; it says so once,
// here, rather than on every file.
for (const notice of policy.notices) {
  process.stderr.write(`[architecture] deprecated: ${notice}\n`);
}

export const rules: {
  readonly imports: OxlintRule;
  readonly exports: OxlintRule;
  readonly members: OxlintRule;
  readonly structure: OxlintRule;
  readonly surface: OxlintRule;
  readonly campaigns: OxlintRule;
} = {
  imports: makeImportsRule(policy),
  exports: makeExportsRule(policy),
  members: makeMembersRule(policy),
  structure: makeStructureRule(policy),
  surface: makeSurfaceRule(policy),
  // The sectors a `marker` or `nx` perimeter births are read once here,
  // from the markers and the workspace, before any file is linted.
  campaigns: makeCampaignsRule(policy, discoverSectorIndexes(policy)),
};

const plugin: { readonly meta: { readonly name: string }; readonly rules: typeof rules } = {
  meta: { name: "architecture" },
  rules,
};

export default plugin;
