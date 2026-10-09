// What the plugin asks of the campaigns family, as one value.
//
// `@goodbones/campaigns` is an optional peer: a user who never runs a
// campaign does not install it. So nothing outside this folder names it, and
// nothing here reaches it at run time — this module and `none.ts` import its
// types only, which compile away. `live.ts` is the one module that loads it,
// and the composition root reaches `live.ts` through `importOptional`, so a
// repository without the package lints with every other rule.
import type {
  LoadedPolicy as CorePolicy,
  PolicyExtension,
  UninstalledExtension,
} from "@goodbones/core";

import type { OxlintRule } from "../oxlint-api.js";

export type CampaignsHost = {
  // The `campaigns` rule over the loaded policy.
  readonly rule: (policy: CorePolicy) => OxlintRule;
};

// The policy as this host carries it: the core's, with the campaigns family
// it was composed with — the live one, or `none`.
export type LoadedPolicy = CorePolicy & { readonly campaigns: CampaignsHost };

// What the composition root hands the loader for the family: the manifest
// with each `fn` term's function imported and replaced by its name, the
// extension that claims the family's keys — or, with the family not
// installed, those keys named as uninstalled.
export type Composition = {
  readonly manifest: unknown;
  readonly extensions: ReadonlyArray<PolicyExtension>;
  readonly uninstalled: ReadonlyArray<UninstalledExtension>;
};

export type CampaignsFamily = {
  readonly host: CampaignsHost;
  readonly compose: (
    repoRoot: string,
    configPath: string,
    manifest: unknown,
  ) => Promise<Composition>;
  // Run once the policy has loaded and before oxlint lints a file.
  readonly prepare: (policy: CorePolicy) => Promise<void>;
};
