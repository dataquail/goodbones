import * as path from "node:path";

import {
  type ConfigInvalid,
  findManifestFile,
  importOptional,
  type Language,
  loadPolicy,
  makeFileSystemLive,
  type PatternInvalid,
  readManifestFile,
} from "@goodbones/core";
import { typescriptLanguage } from "@goodbones/typescript";
import * as Result from "effect/Result";

import type { CampaignsFamily, LoadedPolicy } from "./campaigns/host.js";
import { campaignsNotInstalled } from "./campaigns/none.js";

export type { LoadedPolicy } from "./campaigns/host.js";

// The language packs this host is composed with. Constructed here and handed
// down as the `Language` port, so nothing below this file names TypeScript —
// or ast-grep, the syntax matcher for the campaigns family's `syntax` term.
// The matcher is an optional peer, with a native binary: composed into the
// pack when it is installed, and a campaign that needs it without it is
// refused at load, naming the package.
export const hostLanguages = async (): Promise<ReadonlyArray<Language>> => {
  const astGrep = await importOptional(() => import("@goodbones/ast-grep"), "@goodbones/ast-grep");
  return [typescriptLanguage(astGrep === null ? {} : { syntax: astGrep.astGrepMatcher() })];
};

// The campaigns family, when `@goodbones/campaigns` is installed beside this
// host, and `none` when it is not. Everything that names the package is
// under `campaigns/`, reached through this one import.
export const hostCampaigns = async (): Promise<CampaignsFamily> =>
  (await importOptional(() => import("./campaigns/live.js"), "@goodbones/campaigns"))
    ?.liveCampaigns ?? campaignsNotInstalled;

// The clock the campaigns are judged by. `ARCHITECTURE_NOW` (an ISO date or
// epoch milliseconds) pins it, for a CI that replays a day or a test that
// needs a stall to have happened.
export const hostNow = (): number => {
  const pinned = process.env.ARCHITECTURE_NOW;
  if (pinned === undefined || pinned === "") return Date.now();
  const parsed = /^\d+$/.test(pinned) ? Number(pinned) : Date.parse(pinned);
  if (Number.isNaN(parsed)) {
    throw new Error(`ARCHITECTURE_NOW is ${JSON.stringify(pinned)}, which is not a date.`);
  }
  return parsed;
};

// The CLI's composition root: read the manifest file, construct the language
// packs and the live file system, and hand them to the loader. The plugin has
// one of its own with the same three lines, on purpose — the two hosts share
// the core and never each other.
// Named, or discovered: architecture.yaml, .yml, .json, or .config.mjs,
// exactly one of which may be present. Absolute.
export const manifestPathOf = (repoRoot: string, configFilename?: string): string =>
  configFilename === undefined
    ? findManifestFile(repoRoot)
    : path.resolve(repoRoot, configFilename);

// `given` is the family to compose: found by `hostCampaigns` unless a
// test names one, which is how the host is run as if the package were absent.
export const loadPolicyFromFile = async (
  repoRoot: string,
  configFilename?: string,
  given?: CampaignsFamily,
): Promise<LoadedPolicy> => {
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
  return { ...loaded.success, campaigns: campaigns.host };
};

// The same composition, for a manifest the host already holds as a value
// rather than a file: the bootstrap `infer` resolves through, and the
// manifest it then proves loads. Failure is returned, not thrown — the caller
// has a sentence to put around it.
export const loadPolicyFromManifest = async (
  repoRoot: string,
  manifest: unknown,
): Promise<Result.Result<LoadedPolicy, ConfigInvalid | PatternInvalid>> => {
  const campaigns = await hostCampaigns();
  const composed = await campaigns.compose(repoRoot, null, manifest);
  const loaded = loadPolicy({
    repoRoot,
    configPath: path.resolve(repoRoot, "architecture.yaml"),
    manifest: composed.manifest,
    languages: await hostLanguages(),
    fileSystem: makeFileSystemLive(repoRoot),
    extensions: composed.extensions,
    uninstalled: composed.uninstalled,
    now: hostNow(),
  });
  return Result.map(loaded, (policy) => ({ ...policy, campaigns: campaigns.host }));
};
