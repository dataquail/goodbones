// What the browser's server asks of the campaigns family, as one value.
//
// `@goodbones/campaigns` is an optional peer: a user who never runs a
// campaign does not install it. So no module the server loads up front
// names it at run time — this module and `none.ts` import its types only,
// which compile away. `live.ts` is the one server module that loads it, and
// the composition root reaches `live.ts` through `importOptional`, so a
// repository without the package draws the Architecture Browser alone.
import type {
  LoadedPolicy,
  ManifestLocator,
  PolicyExtension,
  SourceFacts,
  UninstalledExtension,
} from "@goodbones/core";

import type { CampaignView } from "../../model/campaigns.js";

// What the Campaign Browser's model is built from: the walk the Architecture
// Browser's came from, through the same caches, and the manifest as read.
export type CampaignViewRequest = {
  readonly policy: LoadedPolicy;
  readonly name: string;
  readonly roots: ReadonlyArray<string>;
  readonly walked: ReadonlyArray<string>;
  readonly textOf: (file: string) => string;
  readonly factsOf: (file: string) => SourceFacts;
  readonly manifest: unknown;
  readonly locate: ManifestLocator | undefined;
  readonly manifestPath: string;
  // Whether to run git for the working-tree nudge. Off for a static export.
  readonly nudge: boolean;
};

export type CampaignsHost = {
  // Extensions the campaigns widen the walk with.
  readonly widenedExtensions: (policy: LoadedPolicy) => ReadonlyArray<string>;
  // Every `report` a campaign names, read before any file asks.
  readonly readReports: (policy: LoadedPolicy) => Promise<void>;
  readonly view: (request: CampaignViewRequest) => CampaignView;
  // The files a commit moves, which the nudge compares the working tree to.
  readonly gitPaths: (repoRoot: string) => { readonly head: string; readonly index: string } | null;
};

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
};
