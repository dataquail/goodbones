import * as path from "node:path";

import { astGrepMatcher } from "@goodbones/ast-grep";
import {
  findManifestFile,
  loadCampaignFunctions,
  type LoadedPolicy,
  loadPolicy,
  makeFileSystemLive,
  readManifestFile,
} from "@goodbones/core";
import { typescriptLanguage } from "@goodbones/typescript";
import * as Result from "effect/Result";

export type { LoadedPolicy } from "@goodbones/core";

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
  // The `fn` terms are imported here, before the policy loads, as the CLI
  // does; the pack is composed with ast-grep for the campaigns family's
  // `syntax` term, and the plugin parses with it for that family only.
  const { functions, manifest } = await loadCampaignFunctions(configPath, read.manifest);
  const loaded = loadPolicy({
    repoRoot,
    configPath,
    manifest,
    locate: read.locate,
    languages: [typescriptLanguage({ syntax: astGrepMatcher() })],
    fileSystem: makeFileSystemLive(repoRoot),
    functions,
    now: hostNow(),
  });
  if (Result.isFailure(loaded)) throw loaded.failure;
  return loaded.success;
};
