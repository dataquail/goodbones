import { fingerprintOf } from "@goodbones/core";
import * as Effect from "effect/Effect";

import { loadPolicyFromFile, manifestPathOf } from "./config-loader.js";
import { infer } from "./infer.js";
import { writeBaseline } from "./interface/baseline.command.js";
import { campaigns, objectives } from "./interface/campaigns.command.js";
import { check } from "./interface/check.command.js";
import { conformance } from "./interface/conformance.command.js";
import { coverage } from "./interface/coverage.command.js";
import { explain } from "./interface/explain.command.js";
import { facts } from "./interface/facts.command.js";
import { init } from "./interface/init.command.js";
import { migrate } from "./interface/migrate.command.js";
import { type CliFailure, fail } from "./output.js";

// The policy, run with no linter in the loop.
//
// oxlint's JS plugin API is alpha, and a policy that can only be evaluated by
// one alpha host is a policy with a single point of failure. This adapter is the
// second way to ask the same question — and the only way to write a baseline,
// since that needs every finding at once rather than one file at a time.
//
// It covers all four families. The ones that need a syntax tree read it through
// the language pack's own parse rather than oxlint's; both adapters meet at the
// same vocabulary — a specifier, a binding, a member site — so they answer to
// the same core rather than to each other.

// Each verb is a module of its own under interface/; this file reads argv
// and dispatches.

export {
  collectFindings,
  type CollectOptions,
  type Findings,
  type UnresolvedEdge,
} from "./findings.js";
export { writeBaseline } from "./interface/baseline.command.js";
export { campaigns, objectives } from "./interface/campaigns.command.js";
export { check, type CheckOptions } from "./interface/check.command.js";
export { conformance, type ConformanceOptions } from "./interface/conformance.command.js";
export { coverage } from "./interface/coverage.command.js";
export { explain } from "./interface/explain.command.js";
export { facts } from "./interface/facts.command.js";
export { init } from "./interface/init.command.js";
export { migrate } from "./interface/migrate.command.js";
export type { CliFailure } from "./output.js";
export {
  type CheckReport,
  checkReport,
  type ConformanceReport,
  type CoverageReport,
  type ReportedViolation,
  snapshotOf,
} from "./report.js";

// The commands that judge a campaign, and so ask its report source.
const READS_REPORTS: ReadonlySet<string> = new Set([
  "check",
  "conformance",
  "baseline",
  "campaigns",
  "objectives",
  "explain",
]);

export const run = (
  repoRoot: string,
  argv: ReadonlyArray<string>,
  // From ARCHITECTURE_CONFIG. Absent, the manifest is discovered by name.
  configFilename?: string,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const [command = "check", ...rest] = argv;

    // The three commands that write a manifest rather than read one.
    if (command === "init") return yield* init(repoRoot);

    if (command === "migrate") return yield* migrate(repoRoot, configFilename);

    if (command === "infer") {
      yield* infer(repoRoot, rest, configFilename);

      return;
    }

    // `--against <file>` measures the tree against a manifest other than the
    // repository's own — the target the team is moving toward. Only
    // `conformance` takes it: a `check` against a manifest nobody is held to
    // yet would fail for no one's benefit.
    const againstAt = rest.indexOf("--against");
    const against = againstAt === -1 ? undefined : rest[againstAt + 1];

    if (againstAt !== -1 && (against === undefined || against.startsWith("--"))) {
      return yield* Effect.fail(fail("--against needs a manifest path"));
    }

    if (against !== undefined && command !== "conformance") {
      return yield* Effect.fail(
        fail(`--against is a \`conformance\` flag; ${command} does not take it`),
      );
    }

    const manifestFilename = against ?? configFilename;

    const policy = yield* Effect.tryPromise({
      try: () => loadPolicyFromFile(repoRoot, manifestFilename),
      catch: (cause) => fail(String(cause)),
    });

    yield* Effect.sync(() => {
      for (const notice of policy.notices) process.stderr.write(`deprecated: ${notice}\n`);
    });

    // Every `report` a campaign names is read now, before any file asks:
    // a term's several commands run at once rather than one after another
    // the first time a campaign selects a file. What cannot be read is kept
    // for the campaign to report; a report that does not parse is refused.
    if (READS_REPORTS.has(command)) {
      yield* Effect.tryPromise({
        try: () => policy.campaigns.readReports(policy),
        catch: (cause) => fail(String(cause)),
      });
    }

    const json = rest.includes("--json");

    const positional = rest.filter(
      (argument, index) =>
        argument !== "--json" &&
        argument !== "--against" &&
        (againstAt === -1 || index !== againstAt + 1),
    );

    const roots = positional.length > 0 ? positional : ["packages"];

    switch (command) {
      case "campaigns":
        return yield* campaigns(policy, ["packages"], rest, configFilename);
      case "objectives":
        return yield* objectives(policy, ["packages"], rest);
      case "check":
        return yield* check(policy, roots, {
          format: json ? "json" : "text",
          manifestPath: manifestPathOf(repoRoot, configFilename),
        });
      case "conformance":
        return yield* conformance(policy, roots, {
          format: json ? "json" : "text",
          manifestPath: manifestPathOf(repoRoot, manifestFilename),
        });
      case "baseline":
        return yield* writeBaseline(policy, roots);
      case "explain": {
        const [file, ...explainRoots] = positional;

        if (file === undefined) return yield* Effect.fail(fail("explain needs a file path"));

        return yield* explain(policy, file, explainRoots.length > 0 ? explainRoots : ["packages"]);
      }

      case "coverage":
        return yield* coverage(policy, roots);
      case "facts": {
        const [file] = positional;

        if (file === undefined) return yield* Effect.fail(fail("facts needs a file path"));

        return yield* facts(policy, file, json ? "json" : "text");
      }

      default:
        return yield* Effect.fail(
          fail(
            `unknown command "${command}". Try: check [--json] | conformance [--json] [--against <manifest>] | baseline | campaigns [status --changed | attest | note | history] | objectives [clear | concede] | coverage | explain <file> | facts <file> [--json] | init | infer | migrate`,
          ),
        );
    }
  });

export const fingerprint = fingerprintOf;
