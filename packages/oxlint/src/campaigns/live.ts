import * as path from "node:path";

import {
  campaignsExtension,
  campaignsOf,
  discoverSectors,
  loadCampaignFunctions,
  makeReportSourceLive,
  reportSpecsOf,
  type SectorIndex,
} from "@goodbones/campaigns";
import {
  globToRegExp,
  listSourceFiles,
  listWorkspaceProjects,
  type LoadedPolicy,
  ReportUnavailable,
} from "@goodbones/core";

import type { CampaignsFamily } from "./host.js";
import { makeCampaignsRule } from "./rule.js";

// The campaigns family as the plugin runs it, over `@goodbones/campaigns`.
// The one module that loads the package: the composition root imports it
// through `importOptional`, so its absence is `none`, not a failure to load.

// A `marker` or `nx` perimeter needs the other files to say which sector a
// file is in — the markers, or the workspace's projects — so the plugin
// reads them once at load, from a walk of the repository that reads no
// source text but the markers'. The other perimeters answer from the path
// or the file itself, and need nothing here.
const discoverSectorIndexes = (policy: LoadedPolicy): ReadonlyMap<string, SectorIndex> => {
  const indexes = new Map<string, SectorIndex>();
  const needing = campaignsOf(policy).campaignRules.filter(
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

export const liveCampaigns: CampaignsFamily = {
  // The sectors a `marker` or `nx` perimeter births are read once here,
  // from the markers and the workspace, before any file is linted.
  host: { rule: (policy) => makeCampaignsRule(policy, discoverSectorIndexes(policy)) },
  // The `fn` terms are imported here, before the policy loads, as the CLI
  // does. A `report` command runs once per process — once per editor session
  // for oxlint's language server, which then sees that report until it
  // restarts. A report the build writes to a file is the predictable form.
  compose: async (repoRoot, configPath, manifest) => {
    const loaded = await loadCampaignFunctions(configPath, manifest);
    return {
      manifest: loaded.manifest,
      extensions: [
        campaignsExtension({
          functions: loaded.functions,
          reports: makeReportSourceLive(repoRoot),
        }),
      ],
      uninstalled: [],
    };
  },
  // Every `report` a campaign names is read now, while oxlint has linted
  // nothing. A `command` forks this process, and once the linter is running
  // Linux can refuse the fork: the linter's per-thread AST buffers merge
  // into one mapping larger than RAM and swap together, which the default
  // overcommit heuristic refuses to duplicate. The source keeps the answer,
  // and a failure, so the rules read what was read here — a term's several
  // commands run at once. A report that cannot be read is not a load
  // failure — the campaigns rule reports it once, on the first file a
  // campaign naming it selects; one that does not parse is.
  prepare: async (policy) => {
    const campaigns = campaignsOf(policy);
    await Promise.all(
      reportSpecsOf(campaigns.campaignRules).map(async (spec) => {
        if (campaigns.reports.read !== undefined) return campaigns.reports.read(spec);
        try {
          campaigns.reports.diagnosticsOf(spec, "");
        } catch (cause) {
          if (!(cause instanceof ReportUnavailable)) throw cause;
        }
      }),
    );
  },
};
