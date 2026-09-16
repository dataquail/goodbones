import * as path from "node:path";

import { astGrepMatcher } from "@goodbones/ast-grep";
import {
  findManifestFile,
  loadCampaignFunctions,
  type LoadedPolicy,
  loadPolicy,
  makeFileSystemLive,
  makeReportSourceLive,
  readManifestFile,
  reportSpecsOf,
  ReportUnavailable,
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
    // A `report` command runs once per process — once per editor session
    // for oxlint's language server, which then sees that report until it
    // restarts. A report the build writes to a file is the predictable form.
    reports: makeReportSourceLive(repoRoot),
    now: hostNow(),
  });
  if (Result.isFailure(loaded)) throw loaded.failure;
  const policy = loaded.success;
  // Every `report` a campaign names is read now, while oxlint has linted
  // nothing. A `command` forks this process, and once the linter is running
  // Linux can refuse the fork: the linter's per-thread AST buffers merge
  // into one mapping larger than RAM and swap together, which the default
  // overcommit heuristic refuses to duplicate. The source caches the answer,
  // and a failure, so the rules read what was read here. A report that
  // cannot be read is not a load failure — the campaigns rule reports it
  // once, on the first file a campaign naming it selects.
  for (const spec of reportSpecsOf(policy.campaignRules)) {
    try {
      policy.reports.diagnosticsOf(spec, "");
    } catch (cause) {
      if (!(cause instanceof ReportUnavailable)) throw cause;
    }
  }
  // DIAGNOSTIC (not for merge): what this process looks like at load.
  if (process.platform === "linux") {
    try {
      const { readFileSync } = await import("node:fs");
      const status = readFileSync("/proc/self/status", "utf8")
        .split("\n")
        .filter((line) => /^(VmSize|VmData|VmRSS|Threads)/.test(line))
        .map((line) => line.replace(/\s+/g, " "))
        .join("; ");
      const biggest = readFileSync("/proc/self/maps", "utf8")
        .split("\n")
        .map((line) => /^([0-9a-f]+)-([0-9a-f]+) (\S+)/.exec(line))
        .filter((found): found is RegExpExecArray => found !== null)
        .map((found) => parseInt(found[2] ?? "0", 16) - parseInt(found[1] ?? "0", 16))
        .sort((left, right) => right - left)[0];
      process.stderr.write(
        `[goodbones-diag:load] ${status}; biggest map ${((biggest ?? 0) / 1048576).toFixed(0)}MB\n`,
      );
    } catch {
      // best effort
    }
  }
  return policy;
};
