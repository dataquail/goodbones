import {
  compileExportRules,
  compileImportRules,
  compileMemberRules,
  compileStructure,
  compileSurfaceRules,
  ConfigInvalid,
  exportRulesFailingTheirProbe,
  type ExtensionContext,
  type LoadedExtension,
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
  measureDetectorsOf,
} from "../core/campaigns.js";
import { END_STATE_ROOT, lowerCampaigns, lowerEndState } from "../manifest/lower.js";
import type { Ledger } from "../modules/ledgers/domain/ledger/ledger.root.js";
import type { MeasureLedger } from "../modules/ledgers/domain/measure-ledger/measure-ledger.root.js";
import type { PlanRecord } from "../modules/ledgers/domain/plan/plan.root.js";
import type { BaseSidesClient } from "../modules/ledgers/domain/ports/clients/base-sides.client.js";
import type { GitClient } from "../modules/ledgers/domain/ports/clients/git.client.js";
import type { MeasureCommandsClient } from "../modules/ledgers/domain/ports/clients/measure-commands.client.js";
import type { SectorRecord } from "../modules/ledgers/domain/sector-record/sector-record.root.js";
import { ledgerKeyOf } from "../modules/ledgers/domain/services/campaign-ledgers.service.js";
import { makeBaseSidesClientLive } from "../modules/ledgers/infrastructure/clients/base-sides.client-live.js";
import { makeGitClientLive } from "../modules/ledgers/infrastructure/clients/git.client-live.js";
import { makeMeasureCommandsClientLive } from "../modules/ledgers/infrastructure/clients/measure-commands.client-live.js";
import {
  ledgerPathOf,
  legacyLedgerPathOf,
} from "../modules/ledgers/infrastructure/repositories/ledger.mapper.js";
import { makeObjectiveLedgersRepositoryLive } from "../modules/ledgers/infrastructure/repositories/objective-ledgers.repository-live.js";
import { makePlansRepositoryLive } from "../modules/ledgers/infrastructure/repositories/plans.repository-live.js";
import { makeSectorRecordsRepositoryLive } from "../modules/ledgers/infrastructure/repositories/sector-records.repository-live.js";
import type { CampaignPredicate } from "../ports/campaign-predicate.js";
import { NO_REPORTS, type ReportSource } from "../ports/report-source.js";
import {
  type CampaignClients,
  type CampaignPolicy,
  CAMPAIGNS_EXTENSION_ID,
  type LedgerReaders,
  type LedgerRepositories,
} from "./campaign-policy.js";
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

export type CampaignsExtensionOptions = {
  // The predicate functions the manifest's `fn` terms name, imported by the
  // host before loading — `loadCampaignFunctions` does it.
  readonly functions?: ReadonlyMap<string, CampaignPredicate> | undefined;
  // The host's report source, for the `report` terms. Absent, a term naming
  // one is refused rather than quietly answering nothing.
  readonly reports?: ReportSource | undefined;
  // Where the ledgers are read from and saved to, and the programs the verbs
  // read from. Absent, each is the live one over the repository the policy
  // is loaded from; a test hands in the fakes.
  readonly repositories?: LedgerRepositories | undefined;
  readonly git?: GitClient | undefined;
  readonly baseSides?: BaseSidesClient | undefined;
  readonly commands?: MeasureCommandsClient | undefined;
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

// Every detector a campaign holds: its objectives' (a `has` term's and a
// measure's report and function sources included) and its perimeter's.
const detectorsOf = (rule: CompiledCampaign): ReadonlyArray<CompiledDetector> => [
  ...rule.objectives.flatMap((objective) => {
    const detect = detectorOf(objective);

    return [...(detect === null ? [] : [detect]), ...measureDetectorsOf(objective)];
  }),
  ...(rule.perimeter?.kind === "match" ? [rule.perimeter.detect] : []),
];

type ReadLedgers = {
  readonly ledgers: ReadonlyMap<string, Ledger>;
  readonly measureLedgers: ReadonlyMap<string, MeasureLedger>;
  readonly legacy: ReadonlyMap<string, string>;
  readonly sectorRecords: ReadonlyMap<string, SectorRecord>;
  readonly plans: ReadonlyMap<string, PlanRecord>;
};

// The ledgers, read through their repositories. An absent file is an
// objective with no ledger yet; a malformed one is refused, since reading it
// as empty would report every hit as unrecorded growth. A file in the
// family's first layout — one per campaign, `<dir>/<campaign>.json` — is read
// as the ledger of the campaign's one objective, under the implicit sector,
// and remembered so `clear` can rewrite it where it now belongs.
const readLedgers = (
  configPath: string,
  repositories: LedgerRepositories,
  ledgerDir: string,
  campaigns: ReadonlyArray<CompiledCampaign>,
): Result.Result<ReadLedgers, ConfigInvalid> => {
  const ledgers = new Map<string, Ledger>();
  const measureLedgers = new Map<string, MeasureLedger>();
  const legacy = new Map<string, string>();
  const sectorRecords = new Map<string, SectorRecord>();
  const plans = new Map<string, PlanRecord>();
  const refuse = (detail: string) => Result.fail(new ConfigInvalid({ configPath, detail }));

  for (const campaign of campaigns) {
    for (const objective of campaign.objectives) {
      const at = ledgerPathOf(ledgerDir, campaign.id, objective.id);
      const measured = objective.measure !== null;

      // Either kind in the other's place is refused by name: read as the
      // wrong one it would be a decode error that says nothing about why.
      const wrongKind = (from: string) =>
        refuse(
          measured
            ? `the ledger ${from} is a holdout ledger, and ${campaign.id}/${objective.id} is a scalar objective. Remove it and run \`objectives clear\` to record the number.`
            : `the ledger ${from} is a scalar objective's, and ${campaign.id}/${objective.id} holds out ${objective.holdout ?? "matches"}. Remove it and run \`objectives clear\`.`,
        );

      let found = repositories.ledgers.findOne({ campaign: campaign.id, objective: objective.id });
      let from = at;

      if (Result.isSuccess(found) && found.success === null && campaign.objectives.length === 1) {
        from = legacyLedgerPathOf(ledgerDir, campaign.id);
        found = repositories.ledgers.findOne({ campaign: campaign.id, objective: null });

        if (Result.isSuccess(found) && found.success !== null) legacy.set(campaign.id, from);
      }

      if (Result.isFailure(found)) {
        const { failure } = found;

        switch (failure.reason) {
          case "not-json":
            return refuse(`the ledger ${failure.at} is not JSON: ${failure.detail}`);
          case "not-first-layout":
            return refuse(
              `the ledger ${from} is not in the family's first layout, and an objective's ` +
                `ledger is ${at}. Move it.`,
            );
          case "undecodable":
            if (failure.measure !== measured) return wrongKind(from);

            return refuse(`the ledger ${from} does not decode:\n${failure.detail}`);
          case "misplaced":
            if (failure.measure !== measured) return wrongKind(from);

            return refuse(
              `the ledger ${from} says it belongs to "${failure.detail}", ` +
                `not "${campaign.id}/${objective.id}".`,
            );
        }
      }

      const ledger = found.success;

      if (ledger === null) continue;

      if ("kind" in ledger !== measured) return wrongKind(from);

      if ("kind" in ledger) {
        if (ledger.direction !== objective.direction) {
          return refuse(
            `the ledger ${from} records ${campaign.id}/${objective.id} with \`direction: ${ledger.direction}\`, ` +
              `and the manifest now says \`${objective.direction}\`. A number that changed which way is better is a new objective: ` +
              `remove the ledger and run \`objectives clear\`.`,
          );
        }

        measureLedgers.set(ledgerKeyOf(campaign.id, objective.id), ledger);
        continue;
      }

      ledgers.set(ledgerKeyOf(campaign.id, objective.id), { ...ledger, objective: objective.id });
    }

    const records = repositories.sectorRecords.findAll(campaign.id);

    if (Result.isFailure(records)) {
      const { at, detail, reason } = records.failure;

      switch (reason) {
        case "not-json":
          return refuse(`the ledger ${at} is not JSON: ${detail}`);
        case "undecodable":
          return refuse(`the sector record ${at} does not decode:\n${detail}`);
        case "misplaced":
          return refuse(
            `the sector record ${at} says it belongs to "${detail}", not "${campaign.id}".`,
          );
      }
    }

    for (const record of records.success) {
      sectorRecords.set(ledgerKeyOf(campaign.id, record.sector), record);
    }

    const plan = repositories.plans.findOne(campaign.id);

    if (Result.isFailure(plan)) {
      const { at, detail, reason } = plan.failure;

      return refuse(
        reason === "not-json"
          ? `the ledger ${at} is not JSON: ${detail}`
          : `the plan record ${at} does not decode:\n${detail}`,
      );
    }

    if (plan.success !== null) plans.set(campaign.id, plan.success);
  }

  return Result.succeed({ ledgers, measureLedgers, legacy, sectorRecords, plans });
};

const load = (
  options: CampaignsExtensionOptions,
  context: ExtensionContext<CampaignsManifest>,
): Result.Result<LoadedExtension<CampaignPolicy>, ConfigInvalid | PatternInvalid> => {
  const { config, configPath, extractor, fileSystem, languages, repoRoot, routeFor, spec } =
    context;

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
          `matcher: ${[...new Set(syntaxless)].join(", ")}. For TypeScript, install ` +
          `\`@goodbones/ast-grep\` beside the host, which composes it into the pack when it ` +
          `is there; embedding the loader, compose the pack with it yourself. Or write the ` +
          `detector without it.`,
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
        : failed.measured !== undefined
          ? `${failed.name} (${failed.expected} probe ${failed.probe.path} measured ${String(failed.measured)}, ` +
            `${failed.expected === "ignores" ? "not 0" : failed.probe.value === undefined ? "not above 0" : `not ${String(failed.probe.value)}`})`
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
  // The family's composition point inside `loadPolicy`: the ledgers are read
  // through the host's file system, and written under its repository root.
  const store = { fileSystem, repoRoot, ledgerDir };

  const repositories: LedgerRepositories = options.repositories ?? {
    ledgers: makeObjectiveLedgersRepositoryLive(store),
    sectorRecords: makeSectorRecordsRepositoryLive(store),
    plans: makePlansRepositoryLive(store),
  };

  const clients: CampaignClients = {
    git: options.git ?? makeGitClientLive(repoRoot),
    baseSides: options.baseSides ?? makeBaseSidesClientLive(repoRoot),
    commands: options.commands ?? makeMeasureCommandsClientLive(repoRoot),
  };

  // The ledgers at a ref: the same repositories, over the tree git holds
  // there, and read only.
  const readersAt = (ref: string): LedgerReaders => {
    const at = { fileSystem: clients.git.fileSystemAt(ref), repoRoot, ledgerDir };

    return {
      ledgers: makeObjectiveLedgersRepositoryLive(at),
      sectorRecords: makeSectorRecordsRepositoryLive(at),
    };
  };

  const ledgers = readLedgers(configPath, repositories, ledgerDir, campaignRules.success);

  if (Result.isFailure(ledgers)) return Result.fail(ledgers.failure);

  return Result.succeed({
    value: {
      campaignRules: campaignRules.success,
      ledgers: ledgers.success.ledgers,
      measureLedgers: ledgers.success.measureLedgers,
      legacyLedgers: ledgers.success.legacy,
      sectorRecords: ledgers.success.sectorRecords,
      plans: ledgers.success.plans,
      ledgerDir,
      repositories,
      readersAt,
      clients,
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
  decode: (
    slice: Readonly<Record<string, unknown>>,
    describe: (path: ManifestPath, detail: string) => string,
  ) => decodeCampaigns(slice, describe),
  load: (context) => load(options, context),
});
