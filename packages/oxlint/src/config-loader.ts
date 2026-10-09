import * as path from "node:path";

import {
  findManifestFile,
  importOptional,
  loadPolicy,
  makeFileSystemLive,
  readManifestFile,
} from "@goodbones/core";
import { typescriptLanguage } from "@goodbones/typescript";
import * as Result from "effect/Result";

import type { CampaignsFamily, LoadedPolicy } from "./campaigns/host.js";
import { campaignsNotInstalled } from "./campaigns/none.js";

export type { LoadedPolicy } from "./campaigns/host.js";

// The campaigns family, when `@goodbones/campaigns` is installed beside the
// plugin, and `none` when it is not. Everything that names the package is
// under `campaigns/`, reached through this one import.
const hostCampaigns = async (): Promise<CampaignsFamily> =>
  (await importOptional(() => import("./campaigns/live.js"), "@goodbones/campaigns"))
    ?.liveCampaigns ?? campaignsNotInstalled;

// The clock the campaigns are judged by; `ARCHITECTURE_NOW` pins it, as it
// does for the CLI.
const hostNow = (): number => {
  const pinned = process.env.ARCHITECTURE_NOW;
  if (pinned === undefined || pinned === "") return Date.now();
  const parsed = /^\d+$/.test(pinned) ? Number(pinned) : Date.parse(pinned);
  if (Number.isNaN(parsed)) {
    throw new Error(`ARCHITECTURE_NOW is ${JSON.stringify(pinned)}, which is not a date.`);
  }
  return parsed;
};

// The plugin's composition root: read the manifest file, construct the
// language packs and the live file system, and hand them to the loader. A load
// failure throws out of here and out of oxlint's import of the plugin — a
// plugin that came up with no policy would report nothing and be
// indistinguishable from a clean codebase.
//
// `given` is the family to compose: found by `hostCampaigns` unless a test
// names one, which is how the plugin is run as if the package were absent.
export const loadPolicyFromFile = async (
  repoRoot: string,
  configFilename?: string,
  given?: CampaignsFamily,
): Promise<LoadedPolicy> => {
  // Named, or discovered: architecture.yaml, .yml, .json, or .config.mjs,
  // exactly one of which may be present.
  const configPath =
    configFilename === undefined
      ? findManifestFile(repoRoot)
      : path.resolve(repoRoot, configFilename);
  const read = await readManifestFile(configPath);
  const campaigns = given ?? (await hostCampaigns());
  const composed = await campaigns.compose(repoRoot, configPath, read.manifest);
  // The syntax matcher, for the campaigns family's `syntax` term, is an
  // optional peer with a native binary: composed into the pack when it is
  // installed, and the plugin parses with it for that family only. A
  // campaign that needs it without it is refused at load, naming it.
  const astGrep = await importOptional(() => import("@goodbones/ast-grep"), "@goodbones/ast-grep");
  const loaded = loadPolicy({
    repoRoot,
    configPath,
    manifest: composed.manifest,
    locate: read.locate,
    languages: [typescriptLanguage(astGrep === null ? {} : { syntax: astGrep.astGrepMatcher() })],
    fileSystem: makeFileSystemLive(repoRoot),
    extensions: composed.extensions,
    uninstalled: composed.uninstalled,
    now: hostNow(),
  });
  if (Result.isFailure(loaded)) throw loaded.failure;
  await campaigns.prepare(loaded.success);
  return { ...loaded.success, campaigns: campaigns.host };
};
