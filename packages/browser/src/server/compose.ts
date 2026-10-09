import * as path from "node:path";

import {
  findManifestFile,
  importOptional,
  type Language,
  type LoadedPolicy,
  loadPolicy,
  makeFileSystemLive,
  type ManifestLocator,
  readManifestFile,
} from "@goodbones/core";
import { typescriptLanguage } from "@goodbones/typescript";
import * as Result from "effect/Result";

import type { CampaignsFamily, CampaignsHost } from "./campaigns/host.js";
import { campaignsNotInstalled } from "./campaigns/none.js";

// This host's composition root: the same three lines the CLI and the plugin
// each have, on purpose — the three hosts share the core and never each
// other. Nothing below this file names TypeScript or ast-grep.
//
// The syntax matcher, for the campaigns family's `syntax` term, is an
// optional peer with a native binary: composed into the pack when it is
// installed, and a campaign that needs it without it is refused at load.
export const hostLanguages = async (): Promise<ReadonlyArray<Language>> => {
  const astGrep = await importOptional(() => import("@goodbones/ast-grep"), "@goodbones/ast-grep");
  return [typescriptLanguage(astGrep === null ? {} : { syntax: astGrep.astGrepMatcher() })];
};

// The campaigns family, when `@goodbones/campaigns` is installed beside the
// browser, and `none` when it is not. Everything on the server that names
// the package is under `campaigns/`, reached through this one import.
export const hostCampaigns = async (): Promise<CampaignsFamily> =>
  (await importOptional(() => import("./campaigns/live.js"), "@goodbones/campaigns"))
    ?.liveCampaigns ?? campaignsNotInstalled;

export const hostNow = (): number => {
  const pinned = process.env.ARCHITECTURE_NOW;
  if (pinned === undefined || pinned === "") return Date.now();
  const parsed = /^\d+$/.test(pinned) ? Number(pinned) : Date.parse(pinned);
  if (Number.isNaN(parsed)) {
    throw new Error(`ARCHITECTURE_NOW is ${JSON.stringify(pinned)}, which is not a date.`);
  }
  return parsed;
};

export const manifestPathOf = (repoRoot: string, configFilename?: string): string =>
  configFilename === undefined
    ? findManifestFile(repoRoot)
    : path.resolve(repoRoot, configFilename);

export type LoadedManifest = {
  readonly policy: LoadedPolicy;
  // The campaigns family the policy was composed with.
  readonly campaigns: CampaignsHost;
  // The manifest as read, before decoding.
  readonly manifest: unknown;
  readonly locate: ManifestLocator | undefined;
  // Absolute; the root manifest first, then every file `include` pulled in.
  readonly configPath: string;
  readonly files: ReadonlyArray<string>;
};

// `given` is the family to compose: found by `hostCampaigns` unless a test
// names one, which is how the browser is run as if the package were absent.
export const loadPolicyFromFile = async (
  repoRoot: string,
  configFilename?: string,
  given?: CampaignsFamily,
): Promise<LoadedManifest> => {
  const configPath = manifestPathOf(repoRoot, configFilename);
  const read = await readManifestFile(configPath);
  const campaigns = given ?? (await hostCampaigns());
  const composed = await campaigns.compose(repoRoot, configPath, read.manifest);
  const loaded = loadPolicy({
    repoRoot,
    configPath,
    manifest: composed.manifest,
    locate: read.locate,
    languages: await hostLanguages(),
    fileSystem: makeFileSystemLive(repoRoot),
    extensions: composed.extensions,
    uninstalled: composed.uninstalled,
    now: hostNow(),
  });
  if (Result.isFailure(loaded)) throw loaded.failure;
  return {
    policy: loaded.success,
    campaigns: campaigns.host,
    manifest: read.manifest,
    locate: read.locate,
    configPath,
    files: read.files,
  };
};
