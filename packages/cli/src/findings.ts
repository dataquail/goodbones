import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
  evaluateGraph,
  evaluateMemberSite,
  evaluateResolvedEdge,
  evaluateSelectedBindings,
  evaluateStructure,
  evaluateSurface,
  exportRulesSelecting,
  type Graph,
  hasGraphRules,
  listSourceFiles,
  memberRulesSelecting,
  type ObservedEdge,
  rulesSelecting,
  type SourceFacts,
  surfaceRulesSelecting,
  type Violation,
} from "@goodbones/core";
import * as Result from "effect/Result";

import type { CampaignEvaluation } from "./campaigns/host.js";
import type { LoadedPolicy } from "./config-loader.js";
import { buildGraph } from "./graph.js";

// An edge the resolver could not turn into a file. It is reported on its own,
// since every import rule about it enforces nothing.
export type UnresolvedEdge = {
  readonly file: string;
  readonly specifier: string;
  readonly detail: string;
};

export type Findings = {
  readonly violations: ReadonlyArray<Violation>;
  // Every campaign, evaluated over the files it sees: its sectors, every
  // hit placed in one, each sector's phase. Kept apart from the violations:
  // a hit is debt a campaign is paying down, judged against its ledger
  // rather than the baseline.
  readonly campaigns: ReadonlyArray<CampaignEvaluation>;
  readonly unresolved: ReadonlyArray<UnresolvedEdge>;
  readonly files: number;
  // Every edge resolved from a file under an import rule — what the slack
  // report reads. An edge from a file no import rule selects is not here,
  // since no allowlist could have admitted it.
  readonly edges: ReadonlyArray<ObservedEdge>;
  // The import graph, when a graph rule needed it or the caller asked.
  readonly graph: Graph | null;
};

export type CollectOptions = {
  // Build the graph even when no rule needs it — the snapshot counts cycles
  // and orders violations by it.
  readonly graph?: boolean;
};

export const collectFindings = (
  policy: LoadedPolicy,
  roots: ReadonlyArray<string>,
  options: CollectOptions = {},
): Findings => {
  // A campaign may widen the walk past the packs' extensions; a file only a
  // campaign asked for is seen by the campaigns and by no other family.
  const walked = listSourceFiles(
    policy.repoRoot,
    roots,
    policy.languages,
    policy.campaigns.widenedExtensions(policy),
  );

  const known = new Set(policy.languages.flatMap((one) => one.extensions));
  const files = walked.filter((file) => known.has(path.extname(file)));
  const violations: Array<Violation> = [];
  const unresolved: Array<UnresolvedEdge> = [];
  const edges: Array<ObservedEdge> = [];

  // Each file is read and parsed at most once, whether the per-file
  // families, the graph pass or a campaign asks first.
  const texts = new Map<string, string>();

  const textOf = (file: string): string => {
    const cached = texts.get(file);

    if (cached !== undefined) return cached;
    const text = readFileSync(path.join(policy.repoRoot, file), "utf8");
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

  // The graph is the whole repository resolved at once — the one question no
  // per-file adapter can ask — and is built only when a rule needs it.
  const graph =
    options.graph === true || hasGraphRules(policy.graph)
      ? buildGraph(files, policy.resolver, factsOf)
      : null;

  if (graph !== null && hasGraphRules(policy.graph)) {
    for (const violation of evaluateGraph(policy.graph, graph)) violations.push(violation);
  }

  // The campaigns, over every walked file, through the same caches.
  const campaigns = policy.campaigns.evaluate(policy, roots, walked, { textOf, factsOf });

  for (const file of files) {
    for (const violation of evaluateStructure(policy.structure, policy.fileSystem, file)) {
      violations.push(violation);
    }

    const selectedImports = rulesSelecting(policy.importRules, file);
    const selectedExports = exportRulesSelecting(policy.exportRules, file);
    const selectedMembers = memberRulesSelecting(policy.memberRules, file);
    const selectedSurface = surfaceRulesSelecting(policy.surfaceRules, file);

    if (
      selectedImports.length +
        selectedExports.length +
        selectedMembers.length +
        selectedSurface.length ===
      0
    ) {
      continue;
    }

    const facts = factsOf(file);

    for (const violation of evaluateSurface(selectedSurface, file, facts.exportSites)) {
      violations.push(violation);
    }

    for (const site of facts.memberSites) {
      for (const violation of evaluateMemberSite(selectedMembers, site)) violations.push(violation);
    }

    for (const specifier of facts.specifiers) {
      const edge = { importer: file, specifier };

      // A file no import rule selects never needs its imports resolved, which
      // is what keeps resolution off the hot path for the bulk of the repo.
      if (selectedImports.length > 0) {
        const resolved = policy.resolver.resolve(file, specifier);

        if (Result.isFailure(resolved)) {
          if (policy.config.resolve.unresolved === "off") continue;

          if (policy.ignoreUnresolved.some((pattern) => pattern.test(specifier))) continue;
          unresolved.push({ file, specifier, detail: resolved.failure.detail });
          continue;
        }

        edges.push({ importer: file, target: resolved.success });

        for (const violation of evaluateResolvedEdge(selectedImports, file, resolved.success)) {
          violations.push(violation);
        }
      }

      const bound = facts.bindings.get(specifier) ?? [];

      const exported = evaluateSelectedBindings(selectedExports, policy.resolver, {
        ...edge,
        bindings: bound,
      });

      if (!Result.isFailure(exported)) {
        for (const { violation } of exported.success) violations.push(violation);
      }
    }
  }

  return { violations, campaigns, unresolved, files: files.length, edges, graph };
};
