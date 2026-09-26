import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
  campaignReportsOf,
  campaignsOf,
  evaluateCampaigns,
  type Nudge,
  nudgeOf,
  readDiff,
  reportSpecsOf,
  widenedExtensions,
} from "@goodbones/campaigns";
import { listSourceFiles, type SourceFacts } from "@goodbones/core";

import { type Atlas, buildAtlas } from "../model/atlas.js";
import { type CampaignView, campaignViewOf } from "../model/campaigns.js";
import { type LoadedManifest, loadPolicyFromFile } from "./compose.js";

// One pass over the repository for both browsers: the policy loaded, every
// file read and parsed once, the atlas built from the architecture families
// and the campaign view from the campaigns family. What the CLI's `check`
// does, minus the printing, plus the positions the browsers link through.

export type Collected = {
  readonly atlas: Atlas;
  readonly campaigns: CampaignView;
};

export type CollectOptions = {
  readonly repoRoot: string;
  readonly roots: ReadonlyArray<string>;
  readonly configFilename?: string | undefined;
  // Whether to run git for the working-tree nudge. Off for a static export.
  readonly nudge?: boolean | undefined;
};

const toPosix = (file: string): string => file.split(path.sep).join("/");

export const collect = async (options: CollectOptions): Promise<Collected> => {
  const loaded = await loadPolicyFromFile(options.repoRoot, options.configFilename);
  return collectWith(loaded, options);
};

export const collectWith = async (
  loaded: LoadedManifest,
  options: CollectOptions,
): Promise<Collected> => {
  const { policy } = loaded;
  const name = path.basename(options.repoRoot);
  const manifestPath = toPosix(path.relative(options.repoRoot, loaded.configPath));

  // Every `report` a campaign names is read now, before any file asks.
  await Promise.all(
    reportSpecsOf(campaignsOf(policy).campaignRules).map((spec) =>
      campaignsOf(policy).reports.read?.(spec),
    ),
  );

  const walked = listSourceFiles(
    options.repoRoot,
    options.roots,
    policy.languages,
    widenedExtensions(policy),
  );
  const known = new Set(policy.languages.flatMap((one) => one.extensions));
  const files = walked.filter((file) => known.has(path.extname(file)));

  const texts = new Map<string, string>();
  const textOf = (file: string): string => {
    const cached = texts.get(file);
    if (cached !== undefined) return cached;
    const text = readFileSync(path.join(options.repoRoot, file), "utf8");
    texts.set(file, text);
    return text;
  };
  const parsed = new Map<string, SourceFacts>();
  const factsOf = (file: string): SourceFacts => {
    const cached = parsed.get(file);
    if (cached !== undefined) return cached;
    const facts = policy.extractor.factsOf(file, textOf(file));
    parsed.set(file, facts);
    return facts;
  };

  const atlas = buildAtlas({
    policy,
    name,
    roots: options.roots,
    files,
    factsOf,
    locate: loaded.locate,
    manifestPath,
    manifestFiles: loaded.files.map((file) => ({
      path: toPosix(path.relative(options.repoRoot, file)),
      text: readFileSync(file, "utf8"),
    })),
    now: policy.now,
  });

  const evaluations = evaluateCampaigns(policy, options.roots, walked, { textOf, factsOf });
  const reports = campaignReportsOf(policy, evaluations);
  const nudge = options.nudge === false ? null : nudgeFor(loaded, evaluations);
  const campaigns = campaignViewOf({
    policy,
    name,
    evaluations,
    reports,
    manifest: loaded.manifest,
    locate: loaded.locate,
    manifestPath,
    nudge,
    now: policy.now,
  });

  return { atlas, campaigns };
};

// The nudge for the working tree against HEAD, or nothing where git does
// not answer — a repository with no commits, or none at all.
const nudgeFor = (
  loaded: LoadedManifest,
  evaluations: Parameters<typeof nudgeOf>[1],
): Nudge | null => {
  if (campaignsOf(loaded.policy).campaignRules.length === 0) return null;
  try {
    const diff = readDiff(loaded.policy.repoRoot, null);
    return nudgeOf(loaded.policy, evaluations, diff, null, null, null);
  } catch {
    return null;
  }
};
