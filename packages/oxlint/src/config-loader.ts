import * as path from "node:path";

import { astGrepMatcher } from "@goodbones/ast-grep";
import {
  discoverSectors,
  findManifestFile,
  globToRegExp,
  listSourceFiles,
  listWorkspaceProjects,
  loadCampaignFunctions,
  type LoadedPolicy,
  loadPolicy,
  makeFileSystemLive,
  makeReportSourceLive,
  readManifestFile,
  reportSpecsOf,
  ReportUnavailable,
  type SectorIndex,
} from "@goodbones/core";
import { typescriptLanguage } from "@goodbones/typescript";
import * as Result from "effect/Result";

export type { LoadedPolicy } from "@goodbones/core";

// A `marker` or `nx` perimeter needs the other files to say which sector a
// file is in — the markers, or the workspace's projects — so the plugin
// reads them once at load, from a walk of the repository that reads no
// source text but the markers'. The other perimeters answer from the path
// or the file itself, and need nothing here.
export const discoverSectorIndexes = (policy: LoadedPolicy): ReadonlyMap<string, SectorIndex> => {
  const indexes = new Map<string, SectorIndex>();
  const needing = policy.campaignRules.filter(
    (rule) => rule.perimeter?.kind === "marker" || rule.perimeter?.kind === "nx",
  );
  if (needing.length === 0) return indexes;
  const widened = [...new Set(needing.flatMap((rule) => rule.extensions))];
  const files = listSourceFiles(policy.repoRoot, ["."], policy.languages, widened);
  const known = new Set(policy.languages.flatMap((one) => one.extensions));
  const projects = needing.some((rule) => rule.perimeter?.kind === "nx")
    ? listWorkspaceProjects(policy.repoRoot, ["."])
    : [];
  for (const rule of needing) {
    const scoped = files.filter(
      (file) =>
        rule.scope.some((pattern) => pattern.test(file)) &&
        (known.has(path.extname(file)) || rule.extensions.includes(path.extname(file))),
    );
    indexes.set(
      rule.id,
      discoverSectors(rule, {
        files: scoped,
        readText: (file) => policy.fileSystem.readText(file),
        globToRegExp,
        projects,
      }),
    );
  }
  return indexes;
};

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
  // overcommit heuristic refuses to duplicate. The source keeps the answer,
  // and a failure, so the rules read what was read here — a term's several
  // commands run at once. A report that cannot be read is not a load
  // failure — the campaigns rule reports it once, on the first file a
  // campaign naming it selects; one that does not parse is.
  await Promise.all(
    reportSpecsOf(policy.campaignRules).map(async (spec) => {
      if (policy.reports.read !== undefined) return policy.reports.read(spec);
      try {
        policy.reports.diagnosticsOf(spec, "");
      } catch (cause) {
        if (!(cause instanceof ReportUnavailable)) throw cause;
      }
    }),
  );
  return policy;
};
