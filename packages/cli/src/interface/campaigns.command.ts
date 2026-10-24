import type * as Effect from "effect/Effect";

import type { VerbContext } from "../campaigns/host.js";
import { type LoadedPolicy, loadPolicyFromFile, manifestPathOf } from "../config-loader.js";
import { collectFindings } from "../findings.js";
import type { CliFailure } from "../output.js";

// The campaign commands, answered by the family the host was composed with:
// `campaigns` alone is the status table, `status --changed` the nudge,
// `attest` and `note` write a sector's record, `history` replays the ledgers;
// `objectives clear` and `objectives concede` write the ledgers. Without
// `@goodbones/campaigns` installed, each says what to install.
const verbContext = (
  policy: LoadedPolicy,
  defaultRoots: ReadonlyArray<string>,
  argv: ReadonlyArray<string>,
  configFilename?: string,
): VerbContext => ({
  policy,
  defaultRoots,
  argv,
  evaluate: (roots) => collectFindings(policy, roots).campaigns,
  reload: (repoRoot) => loadPolicyFromFile(repoRoot, configFilename),
  manifestPath: manifestPathOf(policy.repoRoot, configFilename),
});

export const objectives = (
  policy: LoadedPolicy,
  defaultRoots: ReadonlyArray<string>,
  argv: ReadonlyArray<string>,
): Effect.Effect<void, CliFailure> =>
  policy.campaigns.objectives(verbContext(policy, defaultRoots, argv));

export const campaigns = (
  policy: LoadedPolicy,
  defaultRoots: ReadonlyArray<string>,
  argv: ReadonlyArray<string>,
  configFilename?: string,
): Effect.Effect<void, CliFailure> =>
  policy.campaigns.campaigns(verbContext(policy, defaultRoots, argv, configFilename));
