import * as Result from "effect/Result";

import {
  type Baseline,
  type BaselineFilter,
  decodeBaseline,
  EMPTY_BASELINE,
  makeBaselineFilter,
} from "../core/baseline.js";
import {
  type CampaignPredicate,
  campaignsFailingTheirProbe,
  compileCampaignRules,
  type CompiledCampaign,
  type CompiledDetector,
  detectorOf,
  leafTermsOf,
} from "../core/campaigns.js";
import {
  type CompiledExportRule,
  compileExportRules,
  exportRulesFailingTheirProbe,
} from "../core/exports.js";
import {
  type CompiledGraph,
  compileGraphRules,
  graphRulesFailingTheirProbe,
} from "../core/graph.js";
import {
  type CompiledImportRule,
  compileImportRules,
  rulesFailingTheirProbe,
} from "../core/imports.js";
import {
  decodeLedger,
  decodePlanRecord,
  decodeSectorRecord,
  isLegacyLedger,
  type Ledger,
  ledgerPathOf,
  legacyLedgerPathOf,
  type PlanRecord,
  planPathOf,
  type SectorRecord,
} from "../core/ledger.js";
import {
  type CompiledMemberRule,
  compileMemberRules,
  memberRulesFailingTheirProbe,
} from "../core/members.js";
import {
  type CompiledStructure,
  compileStructure,
  structureRulesFailingTheirProbe,
} from "../core/structure.js";
import {
  type CompiledSurfaceRule,
  compileSurfaceRules,
  surfaceRulesFailingTheirProbe,
} from "../core/surface.js";
import type { ResolveScope } from "../domain/architecture-config.js";
import {
  ConfigInvalid,
  ImportUnresolved,
  type PatternInvalid,
} from "../domain/architecture-error.js";
import type { SourceFacts } from "../domain/facts.js";
import type { ManifestLocator } from "../domain/manifest-location.js";
import {
  END_STATE_ROOT,
  lowerEndState,
  type LoweredRules,
  lowerManifest,
} from "../manifest/compile.js";
import { decodeManifest, DEFAULT_LEDGER_DIR, type Manifest } from "../manifest/manifest.js";
import type { FactExtractor } from "../ports/fact-extractor.js";
import type { FileSystem } from "../ports/file-system.js";
import type { Language } from "../ports/language.js";
import type { ModuleResolver } from "../ports/module-resolver.js";
import { NO_REPORTS, type ReportSource } from "../ports/report-source.js";
import type { SyntaxMatcher } from "../ports/syntax-matcher.js";

// A manifest, read by a host, turned into the policy both adapters evaluate.
// Decoding, lowering, compiling and probing happen here, once, with whatever
// languages the host hands in — this tier never names one. The host reads the
// manifest file, constructs its language packs and the live file system, and
// hands them over; that is the whole of what a host has to know.

export type LoadedPolicy = {
  readonly repoRoot: string;
  readonly config: Manifest;
  readonly importRules: ReadonlyArray<CompiledImportRule>;
  readonly exportRules: ReadonlyArray<CompiledExportRule>;
  readonly memberRules: ReadonlyArray<CompiledMemberRule>;
  readonly surfaceRules: ReadonlyArray<CompiledSurfaceRule>;
  // Evaluated by the CLI only; compiled and probed here so a vacuous one fails
  // the plugin's load as well.
  readonly graph: CompiledGraph;
  readonly adoption: LoweredRules["adoption"];
  readonly structure: CompiledStructure;
  // Evaluated by both hosts, one file at a time; the ledgers say which hits
  // are already counted. An objective with no ledger, or a sector no ledger
  // has seen, is one `objectives clear` has not been run for, and `check`
  // says so.
  readonly campaignRules: ReadonlyArray<CompiledCampaign>;
  // Keyed `<campaign>/<objective>`.
  readonly ledgers: ReadonlyMap<string, Ledger>;
  // Ledgers read from the family's first layout, `<ledgerDir>/<campaign>.json`,
  // by campaign: `clear` rewrites each in the new layout and removes it.
  readonly legacyLedgers: ReadonlyMap<string, string>;
  // Keyed `<campaign>/<sector>`.
  readonly sectorRecords: ReadonlyMap<string, SectorRecord>;
  // What `clear` last saw of each campaign's phases, by campaign.
  readonly plans: ReadonlyMap<string, PlanRecord>;
  // Repo-relative; `<ledgerDir>/<campaign>/<objective>.json` is a ledger.
  readonly ledgerDir: string;
  // The predicate functions the host imported for the `fn` terms.
  readonly functions: ReadonlyMap<string, CampaignPredicate>;
  // Answers the `report` terms: the host's live source, or nothing.
  readonly reports: ReportSource;
  // The clock the campaigns are judged by — stalls, timestamps.
  readonly now: number;
  readonly fileSystem: FileSystem;
  // The language packs this policy is evaluated with. The walker takes its
  // extensions from them, and lowering the shape of its probes.
  readonly languages: ReadonlyArray<Language>;
  // Violations this repository is carrying while it adopts the policy. Applied
  // at report time so a baselined finding costs nothing but a line in a file.
  readonly baseline: BaselineFilter;
  // Routes each file to the resolver of the scope that covers it.
  readonly resolver: ModuleResolver;
  // Routes each file to the extractor of the language whose scope covers it.
  // The CLI reads every file through this; the plugin reads oxlint's tree.
  readonly extractor: FactExtractor;
  // Routes each file to the syntax matcher of the language whose scope
  // covers it; `parse` answers `null` for a file whose language has none.
  readonly syntax: SyntaxMatcher;
  readonly ignoreUnresolved: ReadonlyArray<RegExp>;
  // Deprecation notices from reading the manifest. The host prints them once.
  readonly notices: ReadonlyArray<string>;
};

export type LoadPolicyInput = {
  readonly repoRoot: string;
  // Where the manifest came from, for the error that names it.
  readonly configPath: string;
  // The manifest as the host read it — a module's default export, a parsed
  // document — before decoding.
  readonly manifest: unknown;
  // From a data file, where a path in the manifest was written, so a decode
  // error names a line. A module manifest has none to give.
  readonly locate?: ManifestLocator | undefined;
  readonly languages: ReadonlyArray<Language>;
  readonly fileSystem: FileSystem;
  // The predicate functions the manifest's `fn` terms name, imported by the
  // host before loading — the core touches no module loader.
  readonly functions?: ReadonlyMap<string, CampaignPredicate> | undefined;
  // The host's report source, for the `report` terms. Absent, a term
  // answers nothing — a policy with one is refused, since it would be a
  // campaign that can never fire.
  readonly reports?: ReportSource | undefined;
  // For tests and for a CI that pins the clock; defaults to `Date.now()`.
  readonly now?: number | undefined;
};

const NOTHING: SourceFacts = {
  specifiers: [],
  bindings: new Map(),
  memberSites: [],
  exportSites: [],
};

type Route = {
  readonly scope: ResolveScope;
  readonly matches: RegExp;
  readonly language: Language;
};

// Each scope, paired with the language it names. A scope naming a language no
// pack answers to is refused here: every rule about that scope would otherwise
// be evaluated against nothing.
const routesOf = (
  configPath: string,
  scopes: ReadonlyArray<ResolveScope>,
  languages: ReadonlyArray<Language>,
): Result.Result<ReadonlyArray<Route>, ConfigInvalid> => {
  const routes: Array<Route> = [];
  for (const scope of scopes) {
    const language = languages.find((one) => one.id === scope.language);
    if (language === undefined) {
      return Result.fail(
        new ConfigInvalid({
          configPath,
          detail:
            `resolve scope ${JSON.stringify(scope.files)} names the language ` +
            `"${scope.language}", and no language pack by that name is loaded ` +
            `(loaded: ${languages.length === 0 ? "none" : languages.map((one) => one.id).join(", ")}).`,
        }),
      );
    }
    routes.push({ scope, matches: new RegExp(scope.files), language });
  }
  return Result.succeed(routes);
};

const routeFor = (routes: ReadonlyArray<Route>, file: string): Route | undefined =>
  routes.find((route) => route.matches.test(file));

const referencedFunctions = (detect: CompiledDetector): ReadonlyArray<string> => {
  switch (detect.kind) {
    case "all":
    case "any":
      return detect.terms.flatMap(referencedFunctions);
    case "not":
      return referencedFunctions(detect.term);
    case "fn":
      return [detect.name];
    default:
      return [];
  }
};

// Every detector a campaign holds: its objectives' (a `has` term's
// included) and its perimeter's.
const detectorsOf = (rule: CompiledCampaign): ReadonlyArray<CompiledDetector> => [
  ...rule.objectives.flatMap((objective) => {
    const detect = detectorOf(objective);
    return detect === null ? [] : [detect];
  }),
  ...(rule.perimeter?.kind === "match" ? [rule.perimeter.detect] : []),
];

// One resolver per scope, built by the scope's language, behind one port that
// picks the scope by the importing file.
const makeRouter = (
  configPath: string,
  repoRoot: string,
  routes: ReadonlyArray<Route>,
): Result.Result<ModuleResolver, ConfigInvalid> => {
  const resolvers: Array<readonly [Route, ModuleResolver]> = [];
  for (const route of routes) {
    const resolver = route.language.makeResolver(repoRoot, route.scope);
    if (Result.isFailure(resolver)) {
      return Result.fail(new ConfigInvalid({ configPath, detail: resolver.failure.message }));
    }
    resolvers.push([route, resolver.success]);
  }
  return Result.succeed({
    resolve: (fromFile, specifier) => {
      const found = resolvers.find(([route]) => route.matches.test(fromFile));
      if (found === undefined) {
        return Result.fail(
          new ImportUnresolved({
            fromFile,
            specifier,
            detail: "no resolve scope in the architecture config matches this file",
          }),
        );
      }
      return found[1].resolve(fromFile, specifier);
    },
  });
};

// A file is parsed by the language whose scope covers it. A file no scope
// covers reads as nothing — which, for a probe, is a failed probe with a
// message that says so.
const makeRoutingExtractor = (routes: ReadonlyArray<Route>): FactExtractor => ({
  factsOf: (file, text) =>
    routeFor(routes, file)?.language.extractor.factsOf(file, text) ?? NOTHING,
});

// One matcher per scope, behind one port that picks the scope by the file. A
// language without one parses nothing, which a `syntax` term reads as no
// matches — and which the probe check below refuses for a campaign that
// depends on it.
const makeRoutingMatcher = (routes: ReadonlyArray<Route>): SyntaxMatcher => ({
  parse: (file, text) => routeFor(routes, file)?.language.syntax?.parse(file, text) ?? null,
});

// The ledgers, read through the port. An absent file is an objective with
// no ledger yet; a malformed one is refused, since reading it as empty
// would report every hit as unrecorded growth. A file in the family's
// first layout — one per campaign, `<dir>/<campaign>.json` — is read as the
// ledger of the campaign's one objective, under the implicit sector, and
// remembered so `clear` can rewrite it where it now belongs.
type ReadLedgers = {
  readonly ledgers: ReadonlyMap<string, Ledger>;
  readonly legacy: ReadonlyMap<string, string>;
  readonly sectorRecords: ReadonlyMap<string, SectorRecord>;
  readonly plans: ReadonlyMap<string, PlanRecord>;
};

export const ledgerKeyOf = (campaign: string, objective: string): string =>
  `${campaign}/${objective}`;

const readJson = (
  configPath: string,
  fileSystem: FileSystem,
  at: string,
): Result.Result<unknown | null, ConfigInvalid> => {
  const text = fileSystem.readText(at);
  if (text === null) return Result.succeed(null);
  try {
    return Result.succeed(JSON.parse(text) as unknown);
  } catch (cause) {
    return Result.fail(
      new ConfigInvalid({ configPath, detail: `the ledger ${at} is not JSON: ${String(cause)}` }),
    );
  }
};

const readLedgers = (
  configPath: string,
  fileSystem: FileSystem,
  ledgerDir: string,
  campaigns: ReadonlyArray<CompiledCampaign>,
): Result.Result<ReadLedgers, ConfigInvalid> => {
  const ledgers = new Map<string, Ledger>();
  const legacy = new Map<string, string>();
  const sectorRecords = new Map<string, SectorRecord>();
  const plans = new Map<string, PlanRecord>();
  for (const campaign of campaigns) {
    for (const objective of campaign.objectives) {
      const at = ledgerPathOf(ledgerDir, campaign.id, objective.id);
      let raw = readJson(configPath, fileSystem, at);
      if (Result.isFailure(raw)) return Result.fail(raw.failure);
      let from = at;
      if (raw.success === null && campaign.objectives.length === 1) {
        from = legacyLedgerPathOf(ledgerDir, campaign.id);
        raw = readJson(configPath, fileSystem, from);
        if (Result.isFailure(raw)) return Result.fail(raw.failure);
        if (raw.success !== null && !isLegacyLedger(raw.success)) {
          return Result.fail(
            new ConfigInvalid({
              configPath,
              detail:
                `the ledger ${from} is not in the family's first layout, and an objective's ` +
                `ledger is ${at}. Move it.`,
            }),
          );
        }
        if (raw.success !== null) legacy.set(campaign.id, from);
      }
      if (raw.success === null) continue;
      const decoded = decodeLedger(raw.success);
      if (Result.isFailure(decoded)) {
        return Result.fail(
          new ConfigInvalid({
            configPath,
            detail: `the ledger ${from} does not decode:\n${decoded.failure}`,
          }),
        );
      }
      const ledger = decoded.success;
      const expected = from === at ? objective.id : campaign.id;
      if (ledger.campaign !== campaign.id || ledger.objective !== expected) {
        return Result.fail(
          new ConfigInvalid({
            configPath,
            detail:
              `the ledger ${from} says it belongs to "${ledger.campaign}/${ledger.objective}", ` +
              `not "${campaign.id}/${objective.id}".`,
          }),
        );
      }
      ledgers.set(ledgerKeyOf(campaign.id, objective.id), {
        ...ledger,
        objective: objective.id,
      });
    }
    const sectorsDir = `${ledgerDir}/${campaign.id}/sectors`;
    for (const name of fileSystem.list(sectorsDir)) {
      if (!name.endsWith(".json")) continue;
      const at = `${sectorsDir}/${name}`;
      const raw = readJson(configPath, fileSystem, at);
      if (Result.isFailure(raw)) return Result.fail(raw.failure);
      if (raw.success === null) continue;
      const decoded = decodeSectorRecord(raw.success);
      if (Result.isFailure(decoded)) {
        return Result.fail(
          new ConfigInvalid({
            configPath,
            detail: `the sector record ${at} does not decode:\n${decoded.failure}`,
          }),
        );
      }
      if (decoded.success.campaign !== campaign.id) {
        return Result.fail(
          new ConfigInvalid({
            configPath,
            detail: `the sector record ${at} says it belongs to "${decoded.success.campaign}", not "${campaign.id}".`,
          }),
        );
      }
      sectorRecords.set(ledgerKeyOf(campaign.id, decoded.success.sector), decoded.success);
    }
    const planAt = planPathOf(ledgerDir, campaign.id);
    const rawPlan = readJson(configPath, fileSystem, planAt);
    if (Result.isFailure(rawPlan)) return Result.fail(rawPlan.failure);
    if (rawPlan.success !== null) {
      const decoded = decodePlanRecord(rawPlan.success);
      if (Result.isFailure(decoded)) {
        return Result.fail(
          new ConfigInvalid({
            configPath,
            detail: `the plan record ${planAt} does not decode:\n${decoded.failure}`,
          }),
        );
      }
      plans.set(campaign.id, decoded.success);
    }
  }
  return Result.succeed({ ledgers, legacy, sectorRecords, plans });
};

// The baseline is read through the port, so this tier touches no file itself.
// An absent or unreadable one carries nothing, which is the safe direction:
// every violation reports.
const readBaseline = (fileSystem: FileSystem, at: string | undefined): Baseline => {
  if (at === undefined) return EMPTY_BASELINE;
  const text = fileSystem.readText(at);
  if (text === null) return EMPTY_BASELINE;
  try {
    return decodeBaseline(JSON.parse(text) as unknown);
  } catch {
    return EMPTY_BASELINE;
  }
};

// Anything wrong with the policy — a bad shape, an uncompilable pattern, a rule
// that cannot report its own probe — is refused. A policy that loaded with a
// gap reports nothing there and looks exactly like a clean codebase.
export const loadPolicy = (
  input: LoadPolicyInput,
): Result.Result<LoadedPolicy, ConfigInvalid | PatternInvalid> => {
  const { configPath, fileSystem, languages, repoRoot } = input;

  const decoded = decodeManifest(configPath, input.manifest, { locate: input.locate });
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
  const config = decoded.success.manifest;

  const routes = routesOf(configPath, config.resolve.scopes, languages);
  if (Result.isFailure(routes)) return Result.fail(routes.failure);

  // The manifest is the authoring surface; these flat rules are the machine's.
  // The languages tell lowering what a source file in each scope is called, so
  // a synthetic probe is a file of the scope's language.
  const rules = lowerManifest(config, languages, { substitutions: decoded.success.substitutions });

  // The ceilings. A tier that says "not tightened yet" is a sentence someone
  // wrote; a ceiling on how many may say so is what keeps the backlog from
  // becoming the architecture. Exceeding it is a policy that broke its own
  // promise, and is refused like any other invalid policy.
  const ceilings = [
    ["unrestricted", rules.adoption.unrestricted, config.limits?.unrestricted],
    ["partial", rules.adoption.partial, config.limits?.partial],
  ] as const;
  const exceeded = ceilings.flatMap(([label, nodes, ceiling]) =>
    ceiling !== undefined && nodes.length > ceiling
      ? [
          `${label}: ${String(nodes.length)} nodes against a ceiling of ${String(ceiling)} (${nodes.join(", ")})`,
        ]
      : [],
  );
  if (exceeded.length > 0) {
    return Result.fail(
      new ConfigInvalid({
        configPath,
        detail:
          `the policy exceeds its own adoption ceiling — ${exceeded.join("; ")}. ` +
          `Tighten a tier, or raise the ceiling in \`limits\` on purpose.`,
      }),
    );
  }

  const importRules = compileImportRules(rules.imports);
  if (Result.isFailure(importRules)) return Result.fail(importRules.failure);

  const exportRules = compileExportRules(rules.exports);
  if (Result.isFailure(exportRules)) return Result.fail(exportRules.failure);

  // A fix is a rewrite in one language's module syntax. A rule naming one that
  // no loaded language implements would report as fixable and never fix.
  const unfixable = exportRules.success.filter((rule) => {
    const fix = rule.fix;
    return fix !== null && !languages.some((one) => one.fixes.includes(fix));
  });
  if (unfixable.length > 0) {
    return Result.fail(
      new ConfigInvalid({
        configPath,
        detail:
          `these exports rules name a fix no loaded language implements: ` +
          unfixable.map((rule) => `${rule.name} (${rule.fix ?? ""})`).join(", ") +
          `. Drop the fix, or load a language pack that carries it.`,
      }),
    );
  }

  const memberRules = compileMemberRules(rules.members);
  if (Result.isFailure(memberRules)) return Result.fail(memberRules.failure);

  const surfaceRules = compileSurfaceRules(rules.surface);
  if (Result.isFailure(surfaceRules)) return Result.fail(surfaceRules.failure);

  const graph = compileGraphRules(rules.graph);
  if (Result.isFailure(graph)) return Result.fail(graph.failure);

  const structure = compileStructure(rules.structure);
  if (Result.isFailure(structure)) return Result.fail(structure.failure);

  const campaignRules = compileCampaignRules(rules.campaigns);
  if (Result.isFailure(campaignRules)) return Result.fail(campaignRules.failure);

  // A `fn` term names a function the host was to import. One it did not is
  // a term that would answer false for every file, and is refused.
  const functions = input.functions ?? new Map<string, CampaignPredicate>();
  const missing = campaignRules.success.flatMap((rule) =>
    detectorsOf(rule).flatMap((detect) =>
      referencedFunctions(detect).filter((name) => !functions.has(name)),
    ),
  );
  if (missing.length > 0) {
    return Result.fail(
      new ConfigInvalid({
        configPath,
        detail:
          `these campaigns name a predicate function the host did not load: ` +
          `${[...new Set(missing)].join(", ")}. A \`fn\` term is \`module#export\`, resolved ` +
          `relative to the manifest, and the export must be a function.`,
      }),
    );
  }

  // A `report` term is answered by the host's source. Without one every
  // such campaign would report nothing and look complete.
  const reporting = campaignRules.success.filter((rule) =>
    detectorsOf(rule).some((detect) => leafTermsOf(detect).includes("report")),
  );
  if (input.reports === undefined && reporting.length > 0) {
    return Result.fail(
      new ConfigInvalid({
        configPath,
        detail:
          `these campaigns hold a \`report\` term and the host provided no report source: ` +
          `${reporting.map((rule) => rule.name).join(", ")}.`,
      }),
    );
  }

  // A `syntax` term needs a matcher for the language of every file in its
  // scope. The probes are the files the campaign is proven on; a probe whose
  // language has none would pass no probe and mean nothing.
  const syntaxless = campaignRules.success.flatMap((rule) => {
    const proven = [
      ...rule.objectives.map((objective) => ({
        name: objective.name,
        detect: detectorOf(objective),
        probes: objective.probes,
      })),
      ...(rule.perimeter?.kind === "match"
        ? [
            {
              name: `${rule.name}/perimeter`,
              detect: rule.perimeter.detect,
              probes: rule.perimeter.probes,
            },
          ]
        : []),
    ];
    return proven.flatMap(({ detect, name, probes }) => {
      if (detect === null || !leafTermsOf(detect).includes("syntax")) return [];
      return [...probes.fires, ...probes.ignores].flatMap((probe) => {
        const route = routeFor(routes.success, probe.path);
        return route === undefined || route.language.syntax !== undefined
          ? []
          : [`${name} (${probe.path}: ${route.language.id} carries no syntax matcher)`];
      });
    });
  });
  if (syntaxless.length > 0) {
    return Result.fail(
      new ConfigInvalid({
        configPath,
        detail:
          `these campaigns hold a \`syntax\` term in a scope whose language has no syntax ` +
          `matcher: ${[...new Set(syntaxless)].join(", ")}. Compose the language pack with ` +
          `one (\`@goodbones/ast-grep\` for TypeScript), or write the detector without it.`,
      }),
    );
  }

  // A probe carrying a source snippet is parsed by the extractor of the
  // language whose scope covers the probe's file — the same extractor the CLI
  // reads that file through. The plugin reads through oxlint's tree instead,
  // and the parity suite is what holds that tree to this one.
  const extractor = makeRoutingExtractor(routes.success);
  const parsedBy = (rule: { readonly probe: { readonly from: string } }): string => {
    const route = routeFor(routes.success, rule.probe.from);
    return route === undefined
      ? ` — no resolve scope covers its probe ${JSON.stringify(rule.probe.from)}, so no language parsed it`
      : ` — probe parsed by ${route.language.id}, selected by the scope ${JSON.stringify(route.scope.files)}`;
  };
  // An `endState` is compiled and probed once, at an abstract root, before
  // any sector exists to lower it for: a sector-relative tree whose rules
  // cannot fire is refused like any other.
  const endStateFailures: Array<string> = [];
  for (const rule of campaignRules.success) {
    for (const phase of rule.phases) {
      if (phase.endState === undefined) continue;
      let lowered: LoweredRules;
      try {
        lowered = lowerEndState(
          phase.endState as Readonly<Record<string, unknown>>,
          END_STATE_ROOT,
          [],
          config.resolve,
          languages,
        );
      } catch (cause) {
        return Result.fail(
          new ConfigInvalid({
            configPath,
            detail: `campaign "${rule.id}" phase "${phase.id}": its endState does not lower: ${String(cause)}`,
          }),
        );
      }
      const endImports = compileImportRules(lowered.imports);
      if (Result.isFailure(endImports)) return Result.fail(endImports.failure);
      const endExports = compileExportRules(lowered.exports);
      if (Result.isFailure(endExports)) return Result.fail(endExports.failure);
      const endMembers = compileMemberRules(lowered.members);
      if (Result.isFailure(endMembers)) return Result.fail(endMembers.failure);
      const endSurface = compileSurfaceRules(lowered.surface);
      if (Result.isFailure(endSurface)) return Result.fail(endSurface.failure);
      const endStructure = compileStructure(lowered.structure);
      if (Result.isFailure(endStructure)) return Result.fail(endStructure.failure);
      const label = (name: string): string => `${rule.name}/${phase.id}/endState ${name}`;
      endStateFailures.push(
        ...rulesFailingTheirProbe(endImports.success).map((one) => label(one.name)),
        ...exportRulesFailingTheirProbe(endExports.success, extractor).map((one) =>
          label(one.name),
        ),
        ...memberRulesFailingTheirProbe(endMembers.success, extractor).map((one) =>
          label(one.name),
        ),
        ...surfaceRulesFailingTheirProbe(endSurface.success, extractor).map((one) =>
          label(one.name),
        ),
        ...structureRulesFailingTheirProbe(endStructure.success).map(label),
      );
    }
  }

  const vacuous = [
    ...rulesFailingTheirProbe(importRules.success).map((rule) => rule.name),
    ...exportRulesFailingTheirProbe(exportRules.success, extractor).map(
      (rule) => rule.name + (rule.probe.source === undefined ? "" : parsedBy(rule)),
    ),
    ...memberRulesFailingTheirProbe(memberRules.success, extractor).map(
      (rule) => rule.name + (rule.probe.source === undefined ? "" : parsedBy(rule)),
    ),
    ...surfaceRulesFailingTheirProbe(surfaceRules.success, extractor).map(
      (rule) => rule.name + (rule.probe.source === undefined ? "" : parsedBy(rule)),
    ),
    ...structureRulesFailingTheirProbe(structure.success),
    ...graphRulesFailingTheirProbe(graph.success),
    ...campaignsFailingTheirProbe(
      campaignRules.success,
      extractor,
      (file) => routeFor(routes.success, file)?.language.syntax ?? null,
      functions,
    ).map((failed) =>
      failed.outOfScope === true
        ? `${failed.name} (its probe ${failed.probe.path} is outside the campaign's own scope)`
        : failed.expected === "fires"
          ? `${failed.name} (fires probe ${failed.probe.path} did not fire)`
          : failed.expected === "end-shape"
            ? `${failed.name} (no fires probe is a sector in its end shape — one that no objective ` +
              `fires on — so the perimeter would un-birth the sector the moment its first phase was met)`
            : `${failed.name} (ignores probe ${failed.probe.path} fired` +
              (failed.admittedBy === undefined ? ")" : `, admitted by \`${failed.admittedBy}\`)`),
    ),
    ...endStateFailures,
  ];
  if (vacuous.length > 0) {
    return Result.fail(
      new ConfigInvalid({
        configPath,
        detail:
          `these rules do not report their own probe, so they enforce nothing: ` +
          `${vacuous.join(", ")}. Fix the rule or its probe — ` +
          `a rule that cannot flag a violation it was written for is worse than no rule. ` +
          `A probe with a source snippet fails when the parser reads no site of that name ` +
          `out of it; \`architecture facts\` shows what the parser reads.`,
      }),
    );
  }

  // A scope the language cannot build a resolver from — options it does not
  // understand — is a policy whose rules would be evaluated against the wrong
  // files, and is refused.
  const resolver = makeRouter(configPath, repoRoot, routes.success);
  if (Result.isFailure(resolver)) return Result.fail(resolver.failure);

  const ledgerDir = config.ledger ?? DEFAULT_LEDGER_DIR;
  const ledgers = readLedgers(configPath, fileSystem, ledgerDir, campaignRules.success);
  if (Result.isFailure(ledgers)) return Result.fail(ledgers.failure);

  return Result.succeed({
    repoRoot,
    config,
    importRules: importRules.success,
    exportRules: exportRules.success,
    memberRules: memberRules.success,
    surfaceRules: surfaceRules.success,
    graph: graph.success,
    adoption: rules.adoption,
    structure: structure.success,
    campaignRules: campaignRules.success,
    ledgers: ledgers.success.ledgers,
    legacyLedgers: ledgers.success.legacy,
    sectorRecords: ledgers.success.sectorRecords,
    plans: ledgers.success.plans,
    ledgerDir,
    functions,
    reports: input.reports ?? NO_REPORTS,
    now: input.now ?? Date.now(),
    fileSystem,
    languages,
    baseline: makeBaselineFilter(readBaseline(fileSystem, config.baseline)),
    resolver: resolver.success,
    extractor,
    syntax: makeRoutingMatcher(routes.success),
    ignoreUnresolved: (config.resolve.ignoreUnresolved ?? []).map(
      (pattern: string) => new RegExp(pattern),
    ),
    notices: decoded.success.notices,
  });
};
