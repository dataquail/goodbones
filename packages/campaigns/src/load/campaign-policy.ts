import type { LoadedPolicy, SourceFacts } from "@goodbones/core";
import * as Result from "effect/Result";

import type { CompiledCampaign } from "../core/campaigns.js";
import { DEFAULT_LEDGER_DIR } from "../manifest/spec.js";
import type { BaseSidesClient } from "../modules/ledgers/domain/ports/clients/base-sides.client.js";
import type { GitClient } from "../modules/ledgers/domain/ports/clients/git.client.js";
import type { MeasureCommandsClient } from "../modules/ledgers/domain/ports/clients/measure-commands.client.js";
import type { WorkspaceClient } from "../modules/ledgers/domain/ports/clients/workspace.client.js";
import type { ObjectiveLedgersRepository } from "../modules/ledgers/domain/ports/repositories/objective-ledgers.repository.js";
import type { PlansRepository } from "../modules/ledgers/domain/ports/repositories/plans.repository.js";
import type { SectorRecordsRepository } from "../modules/ledgers/domain/ports/repositories/sector-records.repository.js";
import type { Readers } from "../modules/ledgers/domain/services/campaign-evaluation.service.js";
import type { CampaignLedgers } from "../modules/ledgers/domain/services/campaign-ledgers.service.js";
import type { CampaignPredicate } from "../ports/campaign-predicate.js";
import { NO_REPORTS, type ReportSource } from "../ports/report-source.js";

// What the campaigns extension carries on a loaded policy, and how a host
// or a verb reads it back. Apart from the extension that builds it, so a
// verb reads the family's state without reaching the live adapters the
// extension constructs.

export const CAMPAIGNS_EXTENSION_ID = "campaigns";

// Where every ledger, sector record and plan is loaded from and saved to.
export type LedgerRepositories = {
  readonly ledgers: ObjectiveLedgersRepository;
  readonly sectorRecords: SectorRecordsRepository;
  readonly plans: PlansRepository;
};

// The ledgers as they stood at a ref, for reading only: what HEAD's
// ledgers say, which the nudge reads a working tree's own concessions
// against.
export type LedgerReaders = {
  readonly ledgers: Pick<ObjectiveLedgersRepository, "findOne">;
  readonly sectorRecords: Pick<SectorRecordsRepository, "findOne">;
};

// The other programs the verbs read from: git, the exact mode's cache of
// a base tree, a `command` measure's shell, and the walk of a tree.
export type CampaignClients = {
  readonly git: GitClient;
  readonly baseSides: BaseSidesClient;
  readonly commands: MeasureCommandsClient;
  readonly workspace: WorkspaceClient;
};

export type CampaignPolicy = CampaignLedgers & {
  // Evaluated by both hosts, one file at a time; the ledgers say which hits
  // are already counted. An objective with no ledger, or a sector no ledger
  // has seen, is one `objectives clear` has not been run for, and `check`
  // says so.
  readonly campaignRules: ReadonlyArray<CompiledCampaign>;
  // Ledgers read from the family's first layout, `<ledgerDir>/<campaign>.json`,
  // by campaign: `clear` rewrites each in the new layout and removes it.
  readonly legacyLedgers: ReadonlyMap<string, string>;
  // Repo-relative; `<ledgerDir>/<campaign>/<objective>.json` is a ledger.
  readonly ledgerDir: string;
  // What the verbs that write a ledger, a record or a plan save through.
  readonly repositories: LedgerRepositories;
  // The ledgers at a ref, read through git.
  readonly readersAt: (ref: string) => LedgerReaders;
  readonly clients: CampaignClients;
  // The predicate functions the host imported for the `fn` terms.
  readonly functions: ReadonlyMap<string, CampaignPredicate>;
  // Answers the `report` terms: the host's live source, or nothing.
  readonly reports: ReportSource;
};

// A policy with no campaigns has no ledger to read, and no verb that saves
// one: there is nothing for a verb to iterate.
const NO_LEDGERS: LedgerRepositories = {
  ledgers: {
    findOne: () => Result.succeed(null),
    save: () => undefined,
    remove: () => undefined,
  },
  sectorRecords: {
    findOne: () => Result.succeed(null),
    findAll: () => Result.succeed([]),
    save: () => undefined,
  },
  plans: { findOne: () => Result.succeed(null), save: () => undefined },
};

// Nor any program to ask: a host without the family runs no verb of it.
const unasked = (): never => {
  throw new Error("this policy was loaded without the campaigns extension");
};

const NO_CLIENTS: CampaignClients = {
  git: {
    diff: unasked,
    textAt: unasked,
    commitOf: unasked,
    materializeTree: unasked,
    commitsTouching: unasked,
    fileSystemAt: unasked,
  },
  baseSides: { read: () => null, write: () => undefined },
  commands: { outputOf: () => null },
  workspace: { sourceFiles: () => [], projects: () => [] },
};

// A campaign-free policy, for a host that loaded the extension against a
// manifest holding no `campaigns` key at all.
const NOTHING: CampaignPolicy = {
  campaignRules: [],
  ledgers: new Map(),
  measureLedgers: new Map(),
  legacyLedgers: new Map(),
  sectorRecords: new Map(),
  plans: new Map(),
  ledgerDir: DEFAULT_LEDGER_DIR,
  repositories: NO_LEDGERS,
  readersAt: () => NO_LEDGERS,
  clients: NO_CLIENTS,
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

// The extensions every campaign widens the walk to, for the walker.
export const widenedExtensions = (policy: LoadedPolicy): ReadonlyArray<string> => [
  ...new Set(campaignsOf(policy).campaignRules.flatMap((rule) => rule.extensions)),
];

// The files read through the policy's file system and parsed by its
// extractor, each at most once — for a caller that has no walk's caches of
// its own to lend.
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
