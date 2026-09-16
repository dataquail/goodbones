import * as path from "node:path";

import { astGrepMatcher } from "@goodbones/ast-grep";
import {
  type ConfigInvalid,
  findManifestFile,
  type Language,
  loadCampaignFunctions,
  type LoadedPolicy,
  loadPolicy,
  makeFileSystemLive,
  makeReportSourceLive,
  type PatternInvalid,
  readManifestFile,
} from "@goodbones/core";
import { typescriptLanguage } from "@goodbones/typescript";
import * as Result from "effect/Result";

export type { LoadedPolicy } from "@goodbones/core";

// The language packs this host is composed with. Constructed here and handed
// down as the `Language` port, so nothing below this file names TypeScript —
// or ast-grep, which the pack is composed with here for the campaigns
// family's `syntax` term.
export const hostLanguages = (): ReadonlyArray<Language> => [
  typescriptLanguage({ syntax: astGrepMatcher() }),
];

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

export const loadPolicyFromFile = async (
  repoRoot: string,
  configFilename?: string,
): Promise<LoadedPolicy> => {
  const configPath = manifestPathOf(repoRoot, configFilename);
  const read = await readManifestFile(configPath);
  // The `fn` terms are imported here, before the policy loads: the core
  // receives the functions as a map and touches no module loader.
  const { functions, manifest } = await loadCampaignFunctions(configPath, read.manifest);
  const loaded = loadPolicy({
    repoRoot,
    configPath,
    manifest,
    locate: read.locate,
    languages: hostLanguages(),
    fileSystem: makeFileSystemLive(repoRoot),
    functions,
    reports: makeReportSourceLive(repoRoot),
    now: hostNow(),
  });
  if (Result.isFailure(loaded)) throw loaded.failure;
  return loaded.success;
};

// The same composition, for a manifest the host already holds as a value
// rather than a file: the bootstrap `infer` resolves through, and the
// manifest it then proves loads. Failure is returned, not thrown — the caller
// has a sentence to put around it.
export const loadPolicyFromManifest = (
  repoRoot: string,
  manifest: unknown,
): Result.Result<LoadedPolicy, ConfigInvalid | PatternInvalid> =>
  loadPolicy({
    repoRoot,
    configPath: path.resolve(repoRoot, "architecture.yaml"),
    manifest,
    languages: hostLanguages(),
    fileSystem: makeFileSystemLive(repoRoot),
    reports: makeReportSourceLive(repoRoot),
    now: hostNow(),
  });
