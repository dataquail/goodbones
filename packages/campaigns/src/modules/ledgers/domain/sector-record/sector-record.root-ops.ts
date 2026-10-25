import * as Result from "effect/Result";

import type { CompiledCampaign } from "../../../../core/campaigns.js";
import { positionOfRecord, type SectorPosition } from "../../../../core/phases.js";
import type { Attestation, Note, SectorRecord } from "./sector-record.root.js";

// What may happen to a sector's record: `reached` advances, a phase is
// attested or its attestation revoked, a note is left; and where the record
// places the sector, and when it last moved.

// The record's position, as the phase logic reads it: `reached` as an index
// (`-1` when unplaced, or when the phase it names is gone).
export const positionOf = (
  rule: CompiledCampaign,
  record: SectorRecord | undefined,
): SectorPosition => positionOfRecord(rule, record);

// `reached` only advances.
export const reachedRecord = (
  record: SectorRecord,
  rule: CompiledCampaign,
  phase: number,
  now: number,
): SectorRecord => {
  const current = positionOf(rule, record).reached;
  const id = rule.phases[phase]?.id ?? null;

  if (phase <= current || id === null) return record;

  return { ...record, reached: id, since: new Date(now).toISOString() };
};

// The live attestations of `phases` revoked, each with why: a concession
// sent the sector back below them.
export const revokedRecord = (
  record: SectorRecord,
  phases: ReadonlyArray<string>,
  revocation: { readonly at: number; readonly by: string; readonly reason: string },
): SectorRecord => ({
  ...record,
  attested: record.attested.map((one) =>
    one.revoked !== undefined || !phases.includes(one.phase)
      ? one
      : { ...one, revoked: { ...revocation, at: new Date(revocation.at).toISOString() } },
  ),
});

export const attestedRecord = (
  record: SectorRecord,
  entry: Omit<Attestation, "at"> & { readonly at: number },
): SectorRecord => ({
  ...record,
  attested: [...record.attested, { ...entry, at: new Date(entry.at).toISOString() }],
});

// Notes are capped — `NOTE_CAP` of them, each at most `NOTE_LENGTH`
// characters — since the file is reviewed like any other and the nudge
// hands them to an agent. Past either, the note is refused, never cut or
// made room for: the one who wrote it splits or prunes on purpose.
export const NOTE_CAP = 20;
export const NOTE_LENGTH = 500;

export const notedRecord = (
  record: SectorRecord,
  note: Omit<Note, "at"> & { readonly at: number },
): Result.Result<SectorRecord, string> => {
  if (note.text.length > NOTE_LENGTH) {
    return Result.fail(
      `a note is at most ${String(NOTE_LENGTH)} characters, and this one is ${String(note.text.length)}: split it, or say less. Nothing was recorded.`,
    );
  }

  if (record.notes.length >= NOTE_CAP) {
    return Result.fail(
      `${record.sector} already holds ${String(NOTE_CAP)} notes, the most a sector keeps: remove one from its record in its own commit, then leave this one. Nothing was recorded.`,
    );
  }

  return Result.succeed({
    ...record,
    notes: [...record.notes, { ...note, at: new Date(note.at).toISOString() }],
  });
};

// The sector's own clock: when it last advanced, or was attested or noted.
export const sectorClockOf = (record: SectorRecord): string =>
  [
    record.since,
    ...record.attested.map((one) => one.at),
    ...record.notes.map((one) => one.at),
  ].reduce((a, b) => (a > b ? a : b));

export const SectorRecordRootOps = {
  positionOf,
  reachedRecord,
  revokedRecord,
  attestedRecord,
  notedRecord,
  sectorClockOf,
} as const;
