import {
  compileExportRules,
  compileImportRules,
  compileMemberRules,
  compileStructure,
  compileSurfaceRules,
  ConfigInvalid,
  exportRulesFailingTheirProbe,
  type ExtensionContext,
  type FileSystem,
  type LoadedExtension,
  type LoadedPolicy,
  type LoweredRules,
  type ManifestPath,
  memberRulesFailingTheirProbe,
  type PatternInvalid,
  type PolicyExtension,
  rulesFailingTheirProbe,
  structureRulesFailingTheirProbe,
  surfaceRulesFailingTheirProbe,
} from "@goodbones/core";
import * as Result from "effect/Result";

import {
  campaignsFailingTheirProbe,
  compileCampaignRules,
  type CompiledCampaign,
  type CompiledDetector,
  detectorOf,
  leafTermsOf,
} from "../core/campaigns.js";
import {
  decodeLedger,
  decodePlanRecord,
  decodeSectorRecord,
  isLegacyLedger,
  type Ledger,
  ledgerPathOf,
  legacyLedgerPathOf,
  planPathOf,
  type PlanRecord,
  type SectorRecord,
} from "../core/ledger.js";
import { END_STATE_ROOT, lowerCampaigns, lowerEndState } from "../manifest/lower.js";
import type { CampaignPredicate } from "../ports/campaign-predicate.js";
import { NO_REPORTS, type ReportSource } from "../ports/report-source.js";
import { type CampaignsManifest, decodeCampaigns, DEFAULT_LEDGER_DIR } from "./decode.js";

// The campaigns family as a `PolicyExtension`: everything `loadPolicy` used
// to do for this family, moved to the package that owns it.
//
// It claims two manifest keys, decodes them with its own codec, lowers them
// with the core's glob primitives, compiles and probes the rules, refuses the
// four things a campaign can name that its host cannot answer — a `fn` the
// host did not import, a `report` with no source, a `syntax` term in a scope
// whose language has no matcher, an `endState` that lowers to nothing — and
// reads the ledgers off the file system port. The core carries the result and
// never looks inside it; `campaignsOf(policy)` is how a host reads it back.

export const CAMPAIGNS_EXTENSION_ID = "campaigns";

// Keyed `<campaign>/<objective>`, and `<campaign>/<sector>` for a record.
export const ledgerKeyOf = (campaign: string, objective: string): string =>
  `${campaign}/${objective}`;

export type CampaignPolicy = {
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
};

// A campaign-free policy, for a host that loaded the extension against a
// manifest holding no `campaigns` key at all.
const NOTHING: CampaignPolicy = {
  campaignRules: [],
  ledgers: new Map(),
  legacyLedgers: new Map(),
  sectorRecords: new Map(),
  plans: new Map(),
  ledgerDir: DEFAULT_LEDGER_DIR,
  functions: new Map(),
  reports: NO_REPORTS,
};

// What a host reads back off the policy. A policy loaded without this
// extension answers the empty family rather than throwing: `architecture
// check` on a manifest with no campaigns is not an error.
export const campaignsOf = (policy: LoadedPolicy): CampaignPolicy => {
  const found = policy.extensions.get(CAMPAIGNS_EXTENSION_ID);
  return found === undefined ? NOTHING : (found as CampaignPolicy);
};

export type CampaignsExtensionOptions = {
  // The predicate functions the manifest's `fn` terms name, imported by the
  // host before loading — `loadCampaignFunctions` does it.
  readonly functions?: ReadonlyMap<string, CampaignPredicate> | undefined;
  // The host's report source, for the `report` terms. Absent, a term naming
  // one is refused rather than quietly answering nothing.
  readonly reports?: ReportSource | undefined;
};

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

// Every detector a campaign holds: its objectives' (a `has` term's included)
// and its perimeter's.
const detectorsOf = (rule: CompiledCampaign): ReadonlyArray<CompiledDetector> => [
  ...rule.objectives.flatMap((objective) => {
    const detect = detectorOf(objective);
    return detect === null ? [] : [detect];
  }),
  ...(rule.perimeter?.kind === "match" ? [rule.perimeter.detect] : []),
];

type ReadLedgers = {
  readonly ledgers: ReadonlyMap<string, Ledger>;
  readonly legacy: ReadonlyMap<string, string>;
  readonly sectorRecords: ReadonlyMap<string, SectorRecord>;
  readonly plans: ReadonlyMap<string, PlanRecord>;
};

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

// The ledgers, read through the port. An absent file is an objective with no
// ledger yet; a malformed one is refused, since reading it as empty would
// report every hit as unrecorded growth. A file in the family's first layout
// — one per campaign, `<dir>/<campaign>.json` — is read as the ledger of the
// campaign's one objective, under the implicit sector, and remembered so
// `clear` can rewrite it where it now belongs.
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

const load = (
  options: CampaignsExtensionOptions,
  context: ExtensionContext<CampaignsManifest>,
): Result.Result<LoadedExtension<CampaignPolicy>, ConfigInvalid | PatternInvalid> => {
  const { config, configPath, extractor, fileSystem, languages, routeFor, spec } = context;

  // Lowering refuses a shape the schema cannot — a phase naming an objective
  // that is not there, an `endState` over a multi-root perimeter — and it
  // refuses by throwing, as the core's own lowering does. That is the very
  // thing this repository's `lowering-reports-not-throws` campaign is paying
  // down; it is not this extension's to change on the way past.
  const lowered = lowerCampaigns(spec, config, languages);

  const campaignRules = compileCampaignRules(lowered);
  if (Result.isFailure(campaignRules)) return Result.fail(campaignRules.failure);

  // A `fn` term names a function the host was to import. One it did not is a
  // term that would answer false for every file, and is refused.
  const functions = options.functions ?? new Map<string, CampaignPredicate>();
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

  // A `report` term is answered by the host's source. Without one every such
  // campaign would report nothing and look complete.
  const reporting = campaignRules.success.filter((rule) =>
    detectorsOf(rule).some((detect) => leafTermsOf(detect).includes("report")),
  );
  if (options.reports === undefined && reporting.length > 0) {
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
        const route = routeFor(probe.path);
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

  // An `endState` is compiled and probed once, at an abstract root, before any
  // sector exists to lower it for: a sector-relative tree whose rules cannot
  // fire is refused like any other.
  const endStateFailures: Array<string> = [];
  for (const rule of campaignRules.success) {
    for (const phase of rule.phases) {
      if (phase.endState === undefined) continue;
      let loweredEnd: LoweredRules;
      try {
        loweredEnd = lowerEndState(
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
      const endImports = compileImportRules(loweredEnd.imports);
      if (Result.isFailure(endImports)) return Result.fail(endImports.failure);
      const endExports = compileExportRules(loweredEnd.exports);
      if (Result.isFailure(endExports)) return Result.fail(endExports.failure);
      const endMembers = compileMemberRules(loweredEnd.members);
      if (Result.isFailure(endMembers)) return Result.fail(endMembers.failure);
      const endSurface = compileSurfaceRules(loweredEnd.surface);
      if (Result.isFailure(endSurface)) return Result.fail(endSurface.failure);
      const endStructure = compileStructure(loweredEnd.structure);
      if (Result.isFailure(endStructure)) return Result.fail(endStructure.failure);
      const label = (name: string): string => `${rule.name}/${phase.id}/endState ${name}`;
      for (const name of [
        ...rulesFailingTheirProbe(endImports.success).map((one) => one.name),
        ...exportRulesFailingTheirProbe(endExports.success, extractor).map((one) => one.name),
        ...memberRulesFailingTheirProbe(endMembers.success, extractor).map((one) => one.name),
        ...surfaceRulesFailingTheirProbe(endSurface.success, extractor).map((one) => one.name),
        ...structureRulesFailingTheirProbe(endStructure.success),
      ]) {
        endStateFailures.push(label(name));
      }
    }
  }

  const vacuous = [
    ...campaignsFailingTheirProbe(
      campaignRules.success,
      extractor,
      (file) => routeFor(file)?.language.syntax ?? null,
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

  const ledgerDir = spec.ledger ?? DEFAULT_LEDGER_DIR;
  const ledgers = readLedgers(configPath, fileSystem, ledgerDir, campaignRules.success);
  if (Result.isFailure(ledgers)) return Result.fail(ledgers.failure);

  return Result.succeed({
    value: {
      campaignRules: campaignRules.success,
      ledgers: ledgers.success.ledgers,
      legacyLedgers: ledgers.success.legacy,
      sectorRecords: ledgers.success.sectorRecords,
      plans: ledgers.success.plans,
      ledgerDir,
      functions,
      reports: options.reports ?? NO_REPORTS,
    },
    vacuous,
  });
};

// The extension, as a host composes it. `loadPolicy({ …, extensions: [
// campaignsExtension({ functions, reports }) ] })`.
export const campaignsExtension = (
  options: CampaignsExtensionOptions = {},
): PolicyExtension<CampaignsManifest, CampaignPolicy> => ({
  id: CAMPAIGNS_EXTENSION_ID,
  manifestKeys: ["campaigns", "ledger"],
  decode: (slice: Readonly<Record<string, unknown>>, describe: (path: ManifestPath, detail: string) => string) =>
    decodeCampaigns(slice, describe),
  load: (context) => load(options, context),
});
