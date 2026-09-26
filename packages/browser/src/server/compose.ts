import * as path from "node:path";

import { astGrepMatcher } from "@goodbones/ast-grep";
import {
  campaignsExtension,
  loadCampaignFunctions,
  makeReportSourceLive,
} from "@goodbones/campaigns";
import {
  findManifestFile,
  type Language,
  type LoadedPolicy,
  loadPolicy,
  makeFileSystemLive,
  type ManifestLocator,
  readManifestFile,
} from "@goodbones/core";
import { typescriptLanguage } from "@goodbones/typescript";
import * as Result from "effect/Result";

// This host's composition root: the same three lines the CLI and the plugin
// each have, on purpose — the three hosts share the core and never each
// other. Nothing below this file names TypeScript or ast-grep.

export const hostLanguages = (): ReadonlyArray<Language> => [
  typescriptLanguage({ syntax: astGrepMatcher() }),
];

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
  // The manifest as read, before decoding.
  readonly manifest: unknown;
  readonly locate: ManifestLocator | undefined;
  // Absolute; the root manifest first, then every file `include` pulled in.
  readonly configPath: string;
  readonly files: ReadonlyArray<string>;
};

export const loadPolicyFromFile = async (
  repoRoot: string,
  configFilename?: string,
): Promise<LoadedManifest> => {
  const configPath = manifestPathOf(repoRoot, configFilename);
  const read = await readManifestFile(configPath);
  const { functions, manifest } = await loadCampaignFunctions(configPath, read.manifest);
  const loaded = loadPolicy({
    repoRoot,
    configPath,
    manifest,
    locate: read.locate,
    languages: hostLanguages(),
    fileSystem: makeFileSystemLive(repoRoot),
    extensions: [campaignsExtension({ functions, reports: makeReportSourceLive(repoRoot) })],
    now: hostNow(),
  });
  if (Result.isFailure(loaded)) throw loaded.failure;
  return {
    policy: loaded.success,
    manifest: read.manifest,
    locate: read.locate,
    configPath,
    files: read.files,
  };
};
