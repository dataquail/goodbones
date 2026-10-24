import { writeFileSync } from "node:fs";
import * as path from "node:path";

import { baselineOf, serializeBaseline } from "@goodbones/core";
import * as Effect from "effect/Effect";

import type { LoadedPolicy } from "../config-loader.js";
import { collectFindings } from "../findings.js";
import { type CliFailure, fail, report } from "../output.js";
import { baselinePathOf } from "../report.js";

export const writeBaseline = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const at = baselinePathOf(policy);

    if (at === null) {
      return yield* Effect.fail(
        fail("this policy declares no `baseline` path, so there is nowhere to write one"),
      );
    }

    const findings = collectFindings(policy, roots);
    const baseline = baselineOf(findings.violations);
    yield* Effect.sync(() => {
      writeFileSync(at, serializeBaseline(baseline));
    });
    yield* report([
      `${String(baseline.entries.length)} violations recorded in ${path.relative(policy.repoRoot, at)}.`,
      "Each one is debt the policy is carrying. Fixing one means deleting its line.",
    ]);
  });
