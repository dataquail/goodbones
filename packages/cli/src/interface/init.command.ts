import { existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { MANIFEST_FILENAMES, MANIFEST_SCHEMA_ID } from "@goodbones/core";
import * as Effect from "effect/Effect";

import { type CliFailure, fail, report } from "../output.js";

export const SCHEMA_HEADER = `# yaml-language-server: $schema=${MANIFEST_SCHEMA_ID}\n`;

// A first manifest: one open root that reaches itself, the ceilings at zero,
// and a comment per section naming the page that explains it. Tight enough to
// fire on the first external import — which is the moment the author learns
// where the allowlist is — and small enough to read in one sitting.
const STARTER_MANIFEST = `${SCHEMA_HEADER}#
# The architecture policy: one manifest of this repository.
# https://dataquail.github.io/goodbones/architecture-rules/manifest/
#
# A key ending in \`/\` is a folder; anything else is a file. The default is
# tight: a folder admits only the children it lists, and a file may import only
# what it or an ancestor allows. Laxity is opted into, by name, at the node that
# wants it. Quote every glob — \`*\` and \`@\` mean something else to YAML bare.

# How an import specifier becomes a file. Every pattern below is matched
# against a resolved path, so this is what makes the rest mean anything.
# https://dataquail.github.io/goodbones/architecture-rules/enforcement/resolution/
resolve:
  scopes:
    - files: ""
      language: typescript
      options: { tsconfig: tsconfig.json }
  unresolved: error

# Violations this repository is carrying while it adopts the policy, keyed by
# fingerprint. Written by \`architecture baseline\`; the floor only rises.
# https://dataquail.github.io/goodbones/architecture-rules/enforcement/baseline/
baseline: .architecture-baseline.json

# Ceilings on how many tiers may say "not tightened yet". At zero, raising one
# is a line in this file a reviewer sees. The same block takes coverage floors
# and ceilings on what \`architecture conformance\` measures, once there are
# numbers to write.
# https://dataquail.github.io/goodbones/architecture-rules/enforcement/adoption/
limits:
  unrestricted: 0
  partial: 0

# Refactors the repository is running, each an object: objectives (a
# detector with a ledger under \`.architecture-campaigns/\` of every place the
# pattern still occurs), over sectors the code births through a perimeter,
# through phases toward an end. Fill one in, then
# \`architecture objectives clear <id>\` to write its ledgers.
# https://dataquail.github.io/goodbones/architecture-rules/manifest/campaigns/
# campaigns:
#   js-to-ts:
#     why: The strict tsconfig cannot land while any src file is JavaScript.
#     how: Rename to .ts, add types at the module boundary, leave the body alone.
#     scope: { path: "src/**", extensions: [.js, .jsx] }
#     perimeter: file
#     objectives:
#       is-ts:
#         intent: A JavaScript file is one the strict compiler never checks.
#         holdout: file
#         match: { path: { file: "\\\\.(js|jsx)$" } }
#         probes: { fires: [{ path: src/legacy/util.js }], ignores: [{ path: src/util.ts }] }
#     staleAfter: 14d
#     onComplete: remove

# The repository. One open root, reaching itself and the runtime; run
# \`architecture check\` to see what else it reaches, and write that down here.
# https://dataquail.github.io/goodbones/architecture-rules/manifest/imports/
tree:
  "src/":
    message: "src/ is the whole program. Nothing in it is layered yet."
    layout: open
    imports:
      message: "This import is not on the allowlist."
      allow: ["src/**", "node:**"]
      # npm packages this tier may reach, by name.
      external: []
    children: {}
`;

// A starter manifest, for a repository that has none.
export const init = (repoRoot: string): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const present = MANIFEST_FILENAMES.filter((name) => existsSync(path.resolve(repoRoot, name)));

    if (present.length > 0) {
      return yield* Effect.fail(
        fail(
          `${present.join(", ")} already exists. \`init\` writes a starter manifest for a ` +
            `repository that has none, and does not overwrite one.`,
        ),
      );
    }

    yield* Effect.sync(() => {
      writeFileSync(path.resolve(repoRoot, "architecture.yaml"), STARTER_MANIFEST);
    });
    yield* report([
      "wrote architecture.yaml.",
      "",
      "  architecture check       # what src/ reaches today; add it to the allowlist by name",
      "  architecture coverage    # how much of the tree the policy reaches",
    ]);
  });
