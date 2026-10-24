import * as path from "node:path";

import * as Effect from "effect/Effect";

import type { LoadedPolicy } from "../config-loader.js";
import { type CliFailure, fail, report } from "../output.js";
import { sourceFactsOf } from "../source-facts.js";

// The other half of `explain`. `explain` says which rules select a file; this
// says what those rules are evaluated against — every edge the parser found,
// the names carried across each, every declared member and called name. A rule
// that "should fire" and does not is one of two mistakes, and this is how to
// tell them apart: the pattern does not select the site, or the site is not a
// fact the adapter extracts.
export const facts = (
  policy: LoadedPolicy,
  file: string,
  format: "text" | "json" = "text",
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const relative = path
      .relative(policy.repoRoot, path.resolve(policy.repoRoot, file))
      .replaceAll(path.sep, "/");

    const read = yield* Effect.try({
      try: () => sourceFactsOf(policy.repoRoot, relative, policy.extractor),
      catch: (cause) => fail(`could not read ${relative}: ${String(cause)}`),
    });

    const edges = read.specifiers.map((specifier) => ({
      specifier,
      bindings: read.bindings.get(specifier) ?? [],
    }));

    const declared = read.memberSites.filter((site) => site.subject === "members");
    const called = read.memberSites.filter((site) => site.subject === "calls");

    if (format === "json") {
      return yield* report([
        JSON.stringify(
          { file: relative, edges, memberSites: read.memberSites, exportSites: read.exportSites },
          null,
          2,
        ),
      ]);
    }

    yield* report([
      relative,
      "",
      edges.length === 0 ? "  edges: (none)" : "  edges:",
      ...edges.flatMap(({ bindings, specifier }) => [
        `    ${specifier}`,
        ...(bindings.length === 0
          ? ["        (no bindings)"]
          : bindings.map((binding) => `        ${binding.kind.padEnd(9)} ${binding.symbol}`)),
      ]),
      "",
      declared.length === 0 ? "  members: (none)" : "  members:",
      ...declared.map((site) => `    ${site.in ?? ""}.${site.name}  (${site.declares ?? "other"})`),
      "",
      called.length === 0 ? "  calls: (none)" : "  calls:",
      ...called.map((site) => `    ${site.name}`),
      "",
      read.exportSites.length === 0 ? "  exports: (none)" : "  exports:",
      ...read.exportSites.map(
        (site) =>
          `    ${site.kind.padEnd(9)} ${site.name}  (${site.reexport ? "re-export" : site.declares})`,
      ),
    ]);
  });
