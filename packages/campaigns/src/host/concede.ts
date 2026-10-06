import type { LoadedPolicy } from "@goodbones/core";
import * as Result from "effect/Result";

import { type CampaignEvaluation, hitsInWindow } from "../core/campaign-state.js";
import type { CompiledCampaign, CompiledObjective } from "../core/campaigns.js";
import {
  concededMeasure,
  concededSector,
  ledgerPathOf,
  measureStandingOf,
  reconcileSector,
  revokedRecord,
  sectorRecordPathOf,
  serializeLedger,
  serializeMeasureLedger,
  serializeSectorRecord,
} from "../core/ledger.js";
import { campaignsOf } from "../load/extension.js";
import { type LedgerOverrides, ledgerPhaseOf } from "./ledger-phase.js";
import { entriesOf, ledgerOf, measureLedgerOf, phaseIdOf, recordOf, writeJson } from "./ledgers.js";

// `concede`: the one way growth enters a ledger, with a reason and an
// author. A concession can send a sector back a phase — its holdouts are
// counted where they belong — and when that crosses an attested phase, what
// was attested no longer holds: the attestation is revoked, and the sector
// stops there again until someone attests anew.

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
// record. A sector no `clear` has placed has no position to lose.
export const sendBack = (
  policy: LoadedPolicy,
  rule: CompiledCampaign,
  sectors: Iterable<string>,
  written: LedgerOverrides,
  revocation: { readonly at: number; readonly by: string; readonly reason: string },
): ReadonlyArray<SentBack> => {
  const sent: Array<SentBack> = [];
  for (const sector of new Set(sectors)) {
    const record = recordOf(policy, rule, sector);
    if (record === undefined) continue;
    const before = ledgerPhaseOf(policy, rule, sector);
    const after = ledgerPhaseOf(policy, rule, sector, written);
    if (after >= before) continue;
    const crossed = rule.phases
      .filter((phase, index) => phase.attested && index > after && index < before)
      .map((phase) => phase.id);
    const revoked = crossed.filter((phase) =>
      record.attested.some((one) => one.phase === phase && one.revoked === undefined),
    );
    if (revoked.length > 0) {
      writeJson(
        policy.repoRoot,
        sectorRecordPathOf(campaignsOf(policy).ledgerDir, rule.id, sector),
        serializeSectorRecord(revokedRecord(record, revoked, revocation)),
      );
    }
    sent.push({
      sector,
      from: phaseIdOf(rule, before),
      to: phaseIdOf(rule, after),
      revoked,
    });
  }
  return sent;
};

export type ConcedeOutcome = {
  readonly objective: string;
  readonly conceded: ReadonlyArray<{ sector: string; entry: string }>;
  readonly left: ReadonlyArray<{ sector: string; entry: string }>;
  // The sectors the concession sent back a phase, with the attestations it
  // revoked on the way.
  readonly sentBack: ReadonlyArray<SentBack>;
};

// `concede`: the unrecorded hits join the ledger, each sector's with a
// concession naming the reason and the author. `chosen` narrows to some.
export const concede = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  objectiveId: string,
  chosen: ReadonlyArray<string> | null,
  sector: string | null,
  record: { at: number; by: string; reason: string },
): Result.Result<ConcedeOutcome, string> => {
  const { rule } = evaluation;
  const objective = rule.objectives.find((one) => one.id === objectiveId);
  if (objective === undefined)
    return Result.fail(`no objective of ${rule.id} is named "${objectiveId}"`);
  if (objective.measure !== null) {
    if (chosen !== null) {
      return Result.fail(
        `${rule.id}/${objectiveId} is a scalar objective: it has no holdouts to choose among. Narrow with --sector.`,
      );
    }
    return concedeMeasure(policy, evaluation, objective, sector, record);
  }
  let ledger = ledgerOf(policy, rule, objective);
  if (ledger === undefined) {
    return Result.fail(
      `objective ${rule.id}/${objectiveId} has no ledger yet; run \`objectives clear ${rule.id}\` first.`,
    );
  }
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
        `these are not unrecorded hits of ${rule.id}/${objectiveId}: ${unknown.join(", ")}`,
      );
    }
  }
  const bySector = new Map<string, Array<string>>();
  for (const one of wanted)
    bySector.set(one.sector, [...(bySector.get(one.sector) ?? []), one.entry]);
  for (const [name, entries] of bySector) ledger = concededSector(ledger, name, entries, record);
  if (wanted.length > 0) {
    writeJson(
      policy.repoRoot,
      ledgerPathOf(campaignsOf(policy).ledgerDir, rule.id, objective.id),
      serializeLedger(ledger),
    );
  }
  return Result.succeed({
    objective: objectiveId,
    conceded: wanted,
    left: unrecorded.filter((one) => !wanted.includes(one)),
    sentBack: sendBack(
      policy,
      rule,
      bySector.keys(),
      { ledgers: new Map([[objective.id, ledger]]) },
      { ...record, reason: `conceded ${objective.id}: ${record.reason}` },
    ),
  });
};

// `concede` for a scalar objective: each sector in window whose value is
// worse than its record past the tolerance is held to its value from now,
// with a concession naming the reason and the author. A sector the ledger
// has not recorded is `clear`'s to enter first.
export const concedeMeasure = (
  policy: LoadedPolicy,
  evaluation: CampaignEvaluation,
  objective: CompiledObjective,
  sector: string | null,
  record: { at: number; by: string; reason: string },
): Result.Result<ConcedeOutcome, string> => {
  const { rule } = evaluation;
  let ledger = measureLedgerOf(policy, rule, objective);
  if (ledger === undefined) {
    return Result.fail(
      `objective ${rule.id}/${objective.id} has no ledger yet; run \`objectives clear ${rule.id}\` first.`,
    );
  }
  const conceded: Array<{ sector: string; entry: string }> = [];
  const left: Array<{ sector: string; entry: string }> = [];
  for (const [name, state] of evaluation.sectors) {
    if (!state.inWindow.some((one) => one.id === objective.id)) continue;
    const value = state.values[objective.id] ?? Number.NaN;
    const standing = Number.isNaN(value)
      ? "unmeasured"
      : measureStandingOf(ledger, name, value, objective.tolerance);
    if (standing !== "breached") continue;
    const from = ledger.sectors[name]?.recorded ?? value;
    const entry = `${String(from)} → ${String(value)}`;
    if (sector !== null && name !== sector) {
      left.push({ sector: name, entry });
      continue;
    }
    ledger = concededMeasure(ledger, name, value, record);
    conceded.push({ sector: name, entry });
  }
  if (conceded.length > 0) {
    writeJson(
      policy.repoRoot,
      ledgerPathOf(campaignsOf(policy).ledgerDir, rule.id, objective.id),
      serializeMeasureLedger(ledger),
    );
  }
  return Result.succeed({
    objective: objective.id,
    conceded,
    left,
    sentBack: sendBack(
      policy,
      rule,
      conceded.map((one) => one.sector),
      { measures: new Map([[objective.id, ledger]]) },
      { ...record, reason: `conceded ${objective.id}: ${record.reason}` },
    ),
  });
};
