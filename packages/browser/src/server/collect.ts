import { readFileSync } from "node:fs";
import * as path from "node:path";

import { listSourceFiles, type SourceFacts } from "@goodbones/core";

import { type Atlas, buildAtlas } from "../model/atlas.js";
import type { CampaignView } from "../model/campaigns.js";
import type { CampaignsFamily } from "./campaigns/host.js";
import { type LoadedManifest, loadPolicyFromFile } from "./compose.js";

// One pass over the repository for both browsers: the policy loaded, every
// file read and parsed once, the atlas built from the architecture families
// and the campaign view from the campaigns family — an empty one, saying
// so, when `@goodbones/campaigns` is not installed. What the CLI's `check`
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
  // The campaigns family to compose, for a test; found when absent.
  readonly campaigns?: CampaignsFamily | undefined;
};

const toPosix = (file: string): string => file.split(path.sep).join("/");

export const collect = async (options: CollectOptions): Promise<Collected> => {
  const loaded = await loadPolicyFromFile(
    options.repoRoot,
    options.configFilename,
    options.campaigns,
  );
  return collectWith(loaded, options);
};

export const collectWith = async (
  loaded: LoadedManifest,
  options: CollectOptions,
): Promise<Collected> => {
  const { campaigns: family, policy } = loaded;
  const name = path.basename(options.repoRoot);
  const manifestPath = toPosix(path.relative(options.repoRoot, loaded.configPath));

  // Every `report` a campaign names is read now, before any file asks.
  await family.readReports(policy);

  const walked = listSourceFiles(
    options.repoRoot,
    options.roots,
    policy.languages,
    family.widenedExtensions(policy),
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

  const campaigns = family.view({
    policy,
    name,
    roots: options.roots,
    walked,
    textOf,
    factsOf,
    manifest: loaded.manifest,
    locate: loaded.locate,
    manifestPath,
    nudge: options.nudge !== false,
  });

  return { atlas, campaigns };
};
