import type { LoadedPolicy } from "@goodbones/core";

import { campaignsOf, readersOf, widenedExtensions } from "../../../load/campaign-policy.js";
import { type BaseSide, baseSideOf } from "../domain/base-side/base-side.value-object.js";
import { evaluateCampaignsOver } from "../domain/services/campaign-evaluation.service.js";

// The exact mode's "before": the campaigns evaluated over the tree at `ref`,
// through a policy loaded from that tree, so `imports`, `requires`, `report`
// and `fn` terms say what the base tree said. A full tool run for a
// `report`-backed objective, so the answer is kept per commit.
export const readBaseSideUseCase = async (
  policy: LoadedPolicy,
  ref: string,
  roots: ReadonlyArray<string>,
  load: (repoRoot: string) => Promise<LoadedPolicy>,
): Promise<BaseSide> => {
  const { baseSides, git, workspace } = campaignsOf(policy).clients;
  let sha: string | null = null;

  try {
    sha = git.commitOf(ref);
  } catch {
    sha = null;
  }

  const cached = sha === null ? null : baseSides.read(sha);

  if (cached !== null) return cached;
  const tree = git.materializeTree(ref);

  try {
    const base = await load(tree.root);
    const campaigns = campaignsOf(base);
    const files = workspace.sourceFiles(tree.root, roots, base.languages, widenedExtensions(base));

    const side = baseSideOf(
      evaluateCampaignsOver(base, campaigns, files, readersOf(base), {
        projects: () => workspace.projects(base.repoRoot, roots),
        outputOf: campaigns.clients.commands.outputOf,
      }),
    );

    if (sha !== null) baseSides.write(sha, side);

    return side;
  } finally {
    tree.dispose();
  }
};
