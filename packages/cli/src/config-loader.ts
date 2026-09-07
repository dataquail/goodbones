import * as path from "node:path";

import {
  type ConfigInvalid,
  findManifestFile,
  type Language,
  type LoadedPolicy,
  loadPolicy,
  makeFileSystemLive,
  type PatternInvalid,
  readManifestFile,
} from "@goodbones/core";
import { typescriptLanguage } from "@goodbones/typescript";
import * as Result from "effect/Result";

export type { LoadedPolicy } from "@goodbones/core";

// The language packs this host is composed with. Constructed here and handed
// down as the `Language` port, so nothing below this file names TypeScript.
export const hostLanguages = (): ReadonlyArray<Language> => [typescriptLanguage()];

// The CLI's composition root: read the manifest file, construct the language
// packs and the live file system, and hand them to the loader. The plugin has
// one of its own with the same three lines, on purpose — the two hosts share
// the core and never each other.
export const loadPolicyFromFile = async (
  repoRoot: string,
  configFilename?: string,
): Promise<LoadedPolicy> => {
  // Named, or discovered: architecture.yaml, .yml, .json, or .config.mjs,
  // exactly one of which may be present.
  const configPath =
    configFilename === undefined
      ? findManifestFile(repoRoot)
      : path.resolve(repoRoot, configFilename);
  const read = await readManifestFile(configPath);
  const loaded = loadPolicy({
    repoRoot,
    configPath,
    manifest: read.manifest,
    locate: read.locate,
    languages: hostLanguages(),
    fileSystem: makeFileSystemLive(repoRoot),
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
  });
