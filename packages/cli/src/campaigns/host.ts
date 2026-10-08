// What the CLI asks of the campaigns family, as one value.
//
// `@goodbones/campaigns` is an optional peer: a user who never runs a
// campaign does not install it. So nothing outside this folder names it, and
// nothing here reaches it at run time — this module and `none.ts` import its
// types only, which compile away. `live.ts` is the one module that loads it,
// and the composition root reaches `live.ts` through `importOptional`, so a
// repository without the package runs every other command with `none`.
import type { CampaignEvaluation, CampaignReport } from "@goodbones/campaigns";
import type {
  LoadedPolicy as CorePolicy,
  PolicyExtension,
  Snapshot,
  SourceFacts,
  UninstalledExtension,
  Violation,
} from "@goodbones/core";
import type * as Effect from "effect/Effect";

import type { CliFailure } from "../output.js";

// The family's types the rest of the host names, re-exported from here so
// nothing outside this folder names the package, even for a type.
export type { CampaignEvaluation, CampaignReport } from "@goodbones/campaigns";

// The policy as this host carries it: the core's, with the campaigns family
// it was composed with — the live one, or `none`.
export type LoadedPolicy = CorePolicy & { readonly campaigns: CampaignsHost };

// A campaign hit as `check` reports it: the violation, where it falls, and
// whether the objective's ledger carries it.
export type CampaignHit = {
  readonly violation: Violation;
  readonly objective: string;
  readonly sector: string;
  readonly entry: string;
  readonly ledgered: boolean;
};

// The walk's caches, which the campaigns read through so each file is read
// and parsed at most once.
export type Readers = {
  readonly textOf: (file: string) => string;
  readonly factsOf: (file: string) => SourceFacts;
};

// What the `campaigns` and `objectives` commands need from the host that is
// not the family's: the evaluation over a set of roots, the loader a base
// tree is read with, and where the manifest is.
export type VerbContext = {
  readonly policy: LoadedPolicy;
  readonly defaultRoots: ReadonlyArray<string>;
  readonly argv: ReadonlyArray<string>;
  readonly evaluate: (roots: ReadonlyArray<string>) => ReadonlyArray<CampaignEvaluation>;
  readonly reload: (repoRoot: string) => Promise<CorePolicy>;
  readonly manifestPath: string;
};

export type CampaignsHost = {
  // Extensions the campaigns widen the walk with.
  readonly widenedExtensions: (policy: CorePolicy) => ReadonlyArray<string>;
  // Every `report` a campaign names, read before any file asks.
  readonly readReports: (policy: CorePolicy) => Promise<void>;
  readonly evaluate: (
    policy: CorePolicy,
    roots: ReadonlyArray<string>,
    walked: ReadonlyArray<string>,
    readers: Readers,
  ) => ReadonlyArray<CampaignEvaluation>;
  // The hits that count — in window for the sector they fall in.
  readonly hitsOf: (
    policy: CorePolicy,
    evaluations: ReadonlyArray<CampaignEvaluation>,
  ) => ReadonlyArray<CampaignHit>;
  readonly reportsOf: (
    policy: CorePolicy,
    evaluations: ReadonlyArray<CampaignEvaluation>,
  ) => ReadonlyArray<CampaignReport>;
  // Why `check` fails on the campaigns, a sentence each.
  readonly failuresOf: (reports: ReadonlyArray<CampaignReport>) => ReadonlyArray<string>;
  readonly renderReports: (
    reports: ReadonlyArray<CampaignReport>,
    hits: ReadonlyArray<CampaignHit>,
  ) => ReadonlyArray<string>;
  readonly snapshotOf: (
    policy: CorePolicy,
    evaluations: ReadonlyArray<CampaignEvaluation>,
  ) => Snapshot["campaigns"];
  readonly renderRows: (campaigns: Snapshot["campaigns"]) => ReadonlyArray<string>;
  // `explain`'s campaigns section for one file; `evaluate` is asked only when
  // a campaign selects it, since a sector's phase needs every file.
  readonly explainLines: (
    policy: CorePolicy,
    file: string,
    evaluate: () => ReadonlyArray<CampaignEvaluation>,
  ) => ReadonlyArray<string>;
  readonly campaigns: (context: VerbContext) => Effect.Effect<void, CliFailure>;
  readonly objectives: (context: VerbContext) => Effect.Effect<void, CliFailure>;
};

// What the composition root hands the loader for the family: the manifest
// with each `fn` term's function imported and replaced by its name, the
// extension that claims the family's keys — or, with the family not
// installed, those keys named as uninstalled.
export type Composition = {
  readonly manifest: unknown;
  readonly extensions: ReadonlyArray<PolicyExtension>;
  readonly uninstalled: ReadonlyArray<UninstalledExtension>;
};

export type CampaignsFamily = {
  readonly host: CampaignsHost;
  // `configPath` is null for a manifest held as a value, whose `fn` terms
  // have no file to resolve against.
  readonly compose: (
    repoRoot: string,
    configPath: string | null,
    manifest: unknown,
  ) => Promise<Composition>;
};
