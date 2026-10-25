import * as Result from "effect/Result";

import { type CampaignEvaluation, hitsInWindow } from "../../../../core/campaign-state.js";
import type { CompiledCampaign, CompiledObjective } from "../../../../core/campaigns.js";
import type { Ledger } from "../ledger/ledger.root.js";
import { concededSector, reconcileSector } from "../ledger/ledger.root-ops.js";
import type { MeasureLedger } from "../measure-ledger/measure-ledger.root.js";
import { concededMeasure, measureStandingOf } from "../measure-ledger/measure-ledger.root-ops.js";
import type { SectorRecord } from "../sector-record/sector-record.root.js";
import { revokedRecord } from "../sector-record/sector-record.root-ops.js";
import {
  type CampaignLedgers,
  entriesOf,
  type LedgerOverrides,
  ledgerPhaseOf,
  phaseIdOf,
  recordOf,
} from "./campaign-ledgers.service.js";

// `concede`: the one way growth enters a ledger, with a reason and an
// author. A concession can send a sector back a phase — its holdouts are
// counted where they belong — and when that crosses an attested phase, what
// was attested no longer holds: the attestation is revoked, and the sector
// stops there again until someone attests anew. These decide; the verb that
// concedes saves what they answer.

export type ConcessionReceipt = {
  readonly at: number;
  readonly by: string;
  readonly reason: string;
};

// A sector a concession sent back: the phase the ledgers placed it at
// before and after, and the attested phases it fell below, revoked.
export type SentBack = {
  readonly sector: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly revoked: ReadonlyArray<string>;
};

// For each sector, where the ledgers about to be written place it against
// where the loaded ones did; a sector they place earlier is sent back, and
// the live attestations of the attested phases between are revoked in its
// record — which is returned to be saved. A sector no `clear` has placed
// has no position to lose.
export const sendBackOf = (
  state: CampaignLedgers,
  rule: CompiledCampaign,
  sectors: Iterable<string>,
  written: LedgerOverrides,
  revocation: ConcessionReceipt,
): { readonly sent: ReadonlyArray<SentBack>; readonly records: ReadonlyArray<SectorRecord> } => {
  const sent: Array<SentBack> = [];
  const records: Array<SectorRecord> = [];

  for (const sector of new Set(sectors)) {
    const record = recordOf(state, rule, sector);

    if (record === undefined) continue;
    const before = ledgerPhaseOf(state, rule, sector);
    const after = ledgerPhaseOf(state, rule, sector, written);

    if (after >= before) continue;

    const crossed = rule.phases
      .filter((phase, index) => phase.attested && index > after && index < before)
      .map((phase) => phase.id);

    const revoked = crossed.filter((phase) =>
      record.attested.some((one) => one.phase === phase && one.revoked === undefined),
    );

    if (revoked.length > 0) records.push(revokedRecord(record, revoked, revocation));

    sent.push({
      sector,
      from: phaseIdOf(rule, before),
      to: phaseIdOf(rule, after),
      revoked,
    });
  }

  return { sent, records };
};

export type Conceded = {
  readonly conceded: ReadonlyArray<{ sector: string; entry: string }>;
  readonly left: ReadonlyArray<{ sector: string; entry: string }>;
};

// The unrecorded hits joined to the ledger, each sector's with a concession
// naming the reason and the author. `chosen` narrows to some, by entry or
// `<sector>:<entry>`; `sector` to one sector.
export const concededHoldoutsOf = (
  ledger: Ledger,
  evaluation: CampaignEvaluation,
  objective: CompiledObjective,
  chosen: ReadonlyArray<string> | null,
  sector: string | null,
  receipt: ConcessionReceipt,
): Result.Result<Conceded & { readonly ledger: Ledger }, string> => {
  const { rule } = evaluation;
  const counted = hitsInWindow(evaluation);
  const unrecorded: Array<{ sector: string; entry: string }> = [];

  for (const [name, state] of evaluation.sectors) {
    if (!state.inWindow.some((one) => one.id === objective.id)) continue;

    if (sector !== null && name !== sector) continue;
    const entries = entriesOf(counted, objective.id, name);

    for (const entry of reconcileSector(ledger, name, entries, objective.unit).unrecorded) {
      unrecorded.push({ sector: name, entry });
    }
  }

  const wanted =
    chosen === null
      ? unrecorded
      : unrecorded.filter(
          (one) => chosen.includes(one.entry) || chosen.includes(`${one.sector}:${one.entry}`),
        );

  if (chosen !== null) {
    const unknown = chosen.filter(
      (one) => !unrecorded.some((two) => two.entry === one || `${two.sector}:${two.entry}` === one),
    );

    if (unknown.length > 0) {
      return Result.fail(
        `these are not unrecorded hits of ${rule.id}/${objective.id}: ${unknown.join(", ")}`,
      );
    }
  }

  const bySector = new Map<string, Array<string>>();

  for (const one of wanted)
    bySector.set(one.sector, [...(bySector.get(one.sector) ?? []), one.entry]);

  let next = ledger;

  for (const [name, entries] of bySector) next = concededSector(next, name, entries, receipt);

  return Result.succeed({
    ledger: next,
    conceded: wanted,
    left: unrecorded.filter((one) => !wanted.includes(one)),
  });
};

// For a scalar objective: each sector in window whose value is worse than
// its record past the tolerance is held to its value from now, with a
// concession naming the reason and the author. A sector the ledger has not
// recorded is `clear`'s to enter first.
export const concededMeasuresOf = (
  ledger: MeasureLedger,
  evaluation: CampaignEvaluation,
  objective: CompiledObjective,
  sector: string | null,
  receipt: ConcessionReceipt,
): Conceded & { readonly ledger: MeasureLedger } => {
  let next = ledger;
  const conceded: Array<{ sector: string; entry: string }> = [];
  const left: Array<{ sector: string; entry: string }> = [];

  for (const [name, state] of evaluation.sectors) {
    if (!state.inWindow.some((one) => one.id === objective.id)) continue;
    const value = state.values[objective.id] ?? Number.NaN;

    const standing = Number.isNaN(value)
      ? "unmeasured"
      : measureStandingOf(next, name, value, objective.tolerance);

    if (standing !== "breached") continue;
    const from = next.sectors[name]?.recorded ?? value;
    const entry = `${String(from)} → ${String(value)}`;

    if (sector !== null && name !== sector) {
      left.push({ sector: name, entry });
      continue;
    }

    next = concededMeasure(next, name, value, receipt);
    conceded.push({ sector: name, entry });
  }

  return { ledger: next, conceded, left };
};
