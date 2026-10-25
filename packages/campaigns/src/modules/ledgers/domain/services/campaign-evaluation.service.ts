import * as path from "node:path";

import {
  compileExportRules,
  compileImportRules,
  compileMemberRules,
  compileStructure,
  compileSurfaceRules,
  evaluateMemberSite,
  evaluateResolvedEdge,
  evaluateSelectedBindings,
  evaluateStructure,
  evaluateSurface,
  exportRulesSelecting,
  globToRegExp,
  type LoadedPolicy,
  memberRulesSelecting,
  rulesSelecting,
  type SourceFacts,
  surfaceRulesSelecting,
  type Violation,
  type WorkspaceProject,
} from "@goodbones/core";
import * as Result from "effect/Result";

import { type CampaignEvaluation, evaluateCampaign } from "../../../../core/campaign-state.js";
import {
  type CampaignInput,
  type CompiledCampaign,
  type CompiledMeasure,
  detectorOf,
  measureDetectorsOf,
  needsSyntax,
  numberFromOutput,
} from "../../../../core/campaigns.js";
import type { Sector } from "../../../../core/sectors.js";
import type { PhaseRule } from "../../../../domain/config.js";
import { lowerEndState } from "../../../../manifest/lower.js";
import type { CampaignPredicate } from "../../../../ports/campaign-predicate.js";
import type { ReportSource } from "../../../../ports/report-source.js";
import { type CampaignLedgers, recordOf } from "./campaign-ledgers.service.js";

// Every campaign evaluated over the files it sees: each objective's hits
// judged against its ledger per sector, an `endState` evaluated per sector
// with the core's own evaluators. Given what was read — the files' text and
// facts, the workspace's projects, a `command` measure's output — it reads
// nothing itself.

export type Readers = {
  readonly textOf: (file: string) => string;
  readonly factsOf: (file: string) => SourceFacts;
};

// The files read through the policy's file system, each read and parsed at
// most once — for a caller that has no walk's caches of its own to lend.
export const readersOf = (policy: LoadedPolicy): Readers => {
  const texts = new Map<string, string>();
  const parsed = new Map<string, SourceFacts>();

  const textOf = (file: string): string => {
    const cached = texts.get(file);

    if (cached !== undefined) return cached;
    const text = policy.fileSystem.readText(file) ?? "";
    texts.set(file, text);

    return text;
  };

  const factsOf = (file: string): SourceFacts => {
    const cached = parsed.get(file);

    if (cached !== undefined) return cached;
    const facts = policy.extractor.factsOf(file, textOf(file));
    parsed.set(file, facts);

    return facts;
  };

  return { textOf, factsOf };
};

// What the family carries that an evaluation reads: the rules, what the
// host imported for the `fn` terms and answers the `report` terms with, and
// each sector's record.
export type EvaluatedFamily = CampaignLedgers & {
  readonly campaignRules: ReadonlyArray<CompiledCampaign>;
  readonly functions: ReadonlyMap<string, CampaignPredicate>;
  readonly reports: ReportSource;
};

// A `command` measure's number: its output read whole or through the
// measure's pattern, each command asked once for the life of the returned
// function — a number about the repository is one number however many
// sectors ask. A command that could not be spawned, or whose output reads
// as no number, measures `NaN`, and `check` refuses it.
export const commandValuesOf = (
  outputOf: (command: string) => string | null,
): ((measure: CompiledMeasure) => number) => {
  const outputs = new Map<string, string | null>();

  return (measure) => {
    if (measure.kind !== "command") return Number.NaN;

    if (!outputs.has(measure.command)) outputs.set(measure.command, outputOf(measure.command));
    const output = outputs.get(measure.command) ?? null;

    return output === null ? Number.NaN : numberFromOutput(measure, output);
  };
};

// The files a campaign sees: those in its scope with an extension a pack
// walks, or one the campaign's scope widens the walk to.
const filesFor = (
  policy: LoadedPolicy,
  rule: CompiledCampaign,
  files: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const known = new Set(policy.languages.flatMap((one) => one.extensions));

  return files.filter(
    (file) =>
      rule.scope.some((pattern) => pattern.test(file)) &&
      (known.has(path.extname(file)) || rule.extensions.includes(path.extname(file))),
  );
};

// One family of an end state against one sector: the tree lowered with the
// sector's root, compiled, and evaluated over the sector's files the way
// the repository's own tree is.
const endStateViolations = (
  policy: LoadedPolicy,
  readers: Readers,
  sectors: ReadonlyArray<Sector>,
  sector: Sector,
  phase: PhaseRule,
): Readonly<Record<string, ReadonlyArray<Violation>>> => {
  const root = sector.roots[0] ?? "";

  const lowered = lowerEndState(
    phase.endState as Readonly<Record<string, unknown>>,
    root,
    sectors.map((one) => ({ name: one.name, root: one.roots[0] ?? "" })),
    policy.config.resolve,
    policy.languages,
    policy.config.aliases ?? {},
  );

  const unwrap = <A>(compiled: Result.Result<A, { readonly message: string }>): A => {
    if (Result.isFailure(compiled)) throw new Error(compiled.failure.message);

    return compiled.success;
  };

  const imports = unwrap(compileImportRules(lowered.imports));
  const exports = unwrap(compileExportRules(lowered.exports));
  const members = unwrap(compileMemberRules(lowered.members));
  const surface = unwrap(compileSurfaceRules(lowered.surface));
  const structure = unwrap(compileStructure(lowered.structure));

  const found: Record<string, Array<Violation>> = {
    imports: [],
    exports: [],
    members: [],
    surface: [],
    structure: [],
  };

  for (const file of sector.files) {
    for (const one of evaluateStructure(structure, policy.fileSystem, file)) {
      found.structure?.push(one);
    }

    const selectedImports = rulesSelecting(imports, file);
    const selectedExports = exportRulesSelecting(exports, file);
    const selectedMembers = memberRulesSelecting(members, file);
    const selectedSurface = surfaceRulesSelecting(surface, file);

    if (
      selectedImports.length +
        selectedExports.length +
        selectedMembers.length +
        selectedSurface.length ===
      0
    ) {
      continue;
    }

    const facts = readers.factsOf(file);

    for (const one of evaluateSurface(selectedSurface, file, facts.exportSites)) {
      found.surface?.push(one);
    }

    for (const site of facts.memberSites) {
      for (const one of evaluateMemberSite(selectedMembers, site)) found.members?.push(one);
    }

    for (const specifier of facts.specifiers) {
      if (selectedImports.length > 0) {
        const resolved = policy.resolver.resolve(file, specifier);

        if (Result.isSuccess(resolved)) {
          for (const one of evaluateResolvedEdge(selectedImports, file, resolved.success)) {
            found.imports?.push(one);
          }
        }
      }

      const bound = facts.bindings.get(specifier) ?? [];

      const exported = evaluateSelectedBindings(selectedExports, policy.resolver, {
        importer: file,
        specifier,
        bindings: bound,
      });

      if (Result.isSuccess(exported)) {
        for (const { violation } of exported.success) found.exports?.push(violation);
      }
    }
  }

  return found;
};

// Every campaign, evaluated over `files`.
export const evaluateCampaignsOver = (
  policy: LoadedPolicy,
  campaigns: EvaluatedFamily,
  files: ReadonlyArray<string>,
  readers: Readers,
  projects: ReadonlyArray<WorkspaceProject>,
  commandValueOf: (measure: CompiledMeasure) => number,
): ReadonlyArray<CampaignEvaluation> =>
  campaigns.campaignRules.map((rule) => {
    const detectors = [
      ...rule.objectives.flatMap((one) => {
        const detect = detectorOf(one);

        return [...(detect === null ? [] : [detect]), ...measureDetectorsOf(one)];
      }),
      ...(rule.perimeter?.kind === "match" ? [rule.perimeter.detect] : []),
    ];

    const parses = needsSyntax(detectors);

    const inputOf = (file: string): CampaignInput => {
      const text = readers.textOf(file);

      return {
        file,
        text,
        facts: readers.factsOf(file),
        resolver: policy.resolver,
        fileSystem: policy.fileSystem,
        syntax: parses ? policy.syntax.parse(file, text) : null,
        functions: campaigns.functions,
        reports: campaigns.reports,
      };
    };

    const input = {
      files: filesFor(policy, rule, files),
      inputOf,
      readText: (file: string) => readers.textOf(file),
      globToRegExp,
      projects,
      recordOf: (sector: string) => recordOf(campaigns, rule, sector),
      commandValueOf,
    };

    if (!rule.objectives.some((one) => one.endState !== null)) return evaluateCampaign(rule, input);
    // An end state's `{ sector, via }` entries need every sector's root, so
    // the sectors are discovered first and the tree is lowered per sector
    // once they are known. One family's violations are computed with the
    // rest of that sector's, and kept for the other families' asks.
    const known = [...evaluateCampaign(rule, input).index.sectors.values()];
    const endStates = new Map<string, Readonly<Record<string, ReadonlyArray<Violation>>>>();

    const evaluation = evaluateCampaign(rule, {
      ...input,
      endStateOf: (sector, phase, family) => {
        const key = `${sector.name}\u0000${phase.id}`;
        let found = endStates.get(key);

        if (found === undefined) {
          found = endStateViolations(policy, readers, known, sector, phase);
          endStates.set(key, found);
        }

        return found[family] ?? [];
      },
    });

    return evaluation;
  });
