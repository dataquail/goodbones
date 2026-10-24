import type { LoadedPolicy } from "@goodbones/core";

import type { CampaignEvaluation, ObjectiveHit } from "../core/campaign-state.js";
import type { CompiledCampaign, CompiledObjective } from "../core/campaigns.js";
import { campaignsOf, ledgerKeyOf } from "../load/extension.js";
import type { MeasureLedger } from "../modules/ledgers/domain/measure-ledger/measure-ledger.root.js";

// What every verb of the host glue reads the same way: a campaign's ledgers
// and records off the loaded policy, a sector's entries off the hits, and
// the small things each of them reads and renders with.

export const ledgerOf = (
  policy: LoadedPolicy,
  rule: CompiledCampaign,
  objective: CompiledObjective,
) => campaignsOf(policy).ledgers.get(ledgerKeyOf(rule.id, objective.id));

export const measureLedgerOf = (
  policy: LoadedPolicy,
  rule: CompiledCampaign,
  objective: CompiledObjective,
): MeasureLedger | undefined =>
  campaignsOf(policy).measureLedgers.get(ledgerKeyOf(rule.id, objective.id));

// How a scalar reads in a line: its value, and against what.
export const describeValue = (value: number): string =>
  Number.isNaN(value) ? "no number" : String(value);

export const recordOf = (policy: LoadedPolicy, rule: CompiledCampaign, sector: string) =>
  campaignsOf(policy).sectorRecords.get(ledgerKeyOf(rule.id, sector));

export const phaseIdOf = (rule: CompiledCampaign, phase: number): string | null =>
  rule.phases[phase]?.id ?? null;

export const entriesOf = (
  hits: ReadonlyArray<Pick<ObjectiveHit, "objective" | "sector" | "entry">>,
  objective: string,
  sector: string,
): ReadonlyArray<string> =>
  hits.flatMap((hit) => (hit.objective === objective && hit.sector === sector ? [hit.entry] : []));

export const sectorNames = (evaluation: CampaignEvaluation): ReadonlyArray<string> => [
  ...evaluation.sectors.keys(),
];

export const count = (n: number, noun: string, plural = `${noun}s`): string =>
  `${String(n)} ${n === 1 ? noun : plural}`;

// How many holdouts a reader is shown at once: the nearest, not the list.
export const HOLDOUT_CAP = 5;
