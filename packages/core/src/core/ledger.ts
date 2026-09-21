import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { CampaignUnit } from "../domain/architecture-config.js";
import type { CompiledCampaign } from "./campaigns.js";
import { isDefinedPhase, type SectorPosition } from "./phases.js";
import { IMPLICIT_SECTOR } from "./sectors.js";

// An objective's ledger: every place the pattern still occurs, per sector,
// and the record of every time a count was allowed to go up. It is the
// baseline's cousin and not the baseline — same fingerprint, different
// file, different semantics.
//
//   - One file per objective, `<ledger>/<campaign>/<objective>.json`, with
//     every counter and the holdout list per sector inside, so two pull
//     requests paying down the same objective in two sectors edit different
//     regions of the file and merge cleanly.
//   - Growth is only ever recorded, never silent. `clear` reconciles the
//     ledger with the code wherever that is not a regression; `concede` is
//     the one way a holdout is added by hand, and it always appends a
//     concession with a reason, a timestamp and an author.
//   - The arithmetic is checked, per sector:
//     `holdouts.length === initial + Σ delta − cleared − closed`. A
//     hand-added holdout with no concession fails the build, with no git
//     history in the loop.
//   - A holdout that no longer fires is stale, and `check` fails on it as it
//     fails on a stale baseline entry, so progress lands as a visible diff.
//   - A sector leaving an objective's window has its holdouts `closed` —
//     not cleared, so a window shutting is never counted as progress.

export const SectorLedger = Schema.Struct({
  // When the sector entered the objective's window.
  entered: Schema.String,
  // The count the day it did.
  initial: Schema.Finite,
  // Holdouts removed by `clear` since, because they stopped firing.
  cleared: Schema.Finite,
  // Holdouts still firing when the sector left the window.
  closed: Schema.Finite,
  // When a holdout last left the ledger — what the stall clock reads.
  lastCleared: Schema.String,
  // `file` or `file#subject`, relative to the sector's root; `~` for the
  // sector itself. Deduplicated and sorted.
  holdouts: Schema.Array(Schema.String),
});

// Growth conceded with a reason, or a re-baseline authorized by a phase
// concession: the holdouts as of the plan change, `from` the count before
// and `to` the count after.
const Growth = Schema.Struct({
  sector: Schema.String,
  at: Schema.String,
  by: Schema.String,
  delta: Schema.Finite,
  reason: Schema.String,
  holdouts: Schema.Array(Schema.String),
});

const Rebaseline = Schema.Struct({
  sector: Schema.String,
  at: Schema.String,
  by: Schema.String,
  from: Schema.Finite,
  to: Schema.Finite,
  reason: Schema.String,
});

export const Concession = Schema.Union([Growth, Rebaseline]);

export const Ledger = Schema.Struct({
  version: Schema.Literal(2),
  campaign: Schema.String,
  objective: Schema.String,
  created: Schema.String,
  sectors: Schema.Record(Schema.String, SectorLedger),
  concessions: Schema.Array(Concession),
});

export type Ledger = typeof Ledger.Type;
export type SectorLedger = typeof SectorLedger.Type;
export type Concession = typeof Concession.Type;

// The family's first ledger: one campaign, one detector, one flat list.
// Read as one sector — the implicit one, named for the scope — and
// rewritten in the new layout on the next `clear`.
const LedgerV1 = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  created: Schema.String,
  initial: Schema.Finite,
  fixed: Schema.Finite,
  lastProgress: Schema.String,
  regressions: Schema.Array(
    Schema.Struct({
      at: Schema.String,
      by: Schema.String,
      delta: Schema.Finite,
      reason: Schema.String,
      entries: Schema.Array(Schema.String),
    }),
  ),
  entries: Schema.Array(Schema.String),
});

const decode = Schema.decodeUnknownResult(Ledger, { errors: "all", onExcessProperty: "error" });
const decodeV1 = Schema.decodeUnknownResult(LedgerV1, {
  errors: "all",
  onExcessProperty: "error",
});

export const EMPTY_LEDGER = (campaign: string, objective: string, now: number): Ledger => ({
  version: 2,
  campaign,
  objective,
  created: new Date(now).toISOString(),
  sectors: {},
  concessions: [],
});

export const isLegacyLedger = (raw: unknown): boolean =>
  typeof raw === "object" && raw !== null && (raw as { readonly version?: unknown }).version === 1;

// A malformed ledger is refused, unlike a malformed baseline, which reads as
// empty: an empty baseline reports every violation, the safe direction, while
// an empty ledger would report every hit as unrecorded growth and demand a
// concession for debt that was already counted.
export const decodeLedger = (raw: unknown): Result.Result<Ledger, string> => {
  if (isLegacyLedger(raw)) {
    const decoded = decodeV1(raw);
    if (Result.isFailure(decoded)) return Result.fail(String(decoded.failure.issue));
    const old = decoded.success;
    return Result.succeed({
      version: 2,
      campaign: old.id,
      objective: old.id,
      created: old.created,
      sectors: {
        [IMPLICIT_SECTOR]: {
          entered: old.created,
          initial: old.initial,
          cleared: old.fixed,
          closed: 0,
          lastCleared: old.lastProgress,
          holdouts: old.entries,
        },
      },
      concessions: old.regressions.map((one) => ({
        sector: IMPLICIT_SECTOR,
        at: one.at,
        by: one.by,
        delta: one.delta,
        reason: one.reason,
        holdouts: one.entries,
      })),
    });
  }
  const decoded = decode(raw);
  return Result.isFailure(decoded)
    ? Result.fail(String(decoded.failure.issue))
    : Result.succeed(decoded.success);
};

export const serializeLedger = (ledger: Ledger): string => `${JSON.stringify(ledger, null, 2)}\n`;

const sorted = (entries: Iterable<string>): ReadonlyArray<string> => [...new Set(entries)].sort();

export const deltaOf = (concession: Concession): number =>
  "delta" in concession ? concession.delta : concession.to - concession.from;

const concededTotal = (ledger: Ledger, sector: string): number =>
  ledger.concessions
    .filter((one) => one.sector === sector)
    .reduce((sum, one) => sum + deltaOf(one), 0);

export const sectorArithmeticHolds = (ledger: Ledger, sector: string): boolean => {
  const own = ledger.sectors[sector];
  if (own === undefined) return concededTotal(ledger, sector) === 0;
  return (
    own.holdouts.length === own.initial + concededTotal(ledger, sector) - own.cleared - own.closed
  );
};

export const ledgerArithmeticHolds = (ledger: Ledger): boolean =>
  [
    ...new Set([...Object.keys(ledger.sectors), ...ledger.concessions.map((one) => one.sector)]),
  ].every((sector) => sectorArithmeticHolds(ledger, sector));

// A `match` entry is `file#anchor#hash`; an edit inside the anchored
// declaration changes the hash and nothing else, and is the same entry.
const anchorOf = (entry: string): string => entry.slice(0, entry.lastIndexOf("#"));

export type Reconciliation = {
  // Entries the ledger already carries, exactly or by anchor.
  readonly ledgered: ReadonlyArray<string>;
  // Entries the ledger does not carry: unrecorded growth.
  readonly unrecorded: ReadonlyArray<string>;
  // Holdouts no entry produces: cleared, and waiting for `clear`.
  readonly stale: ReadonlyArray<string>;
  // Holdouts whose hash moved under a still-present anchor, with what they
  // read now. `clear` rewrites them; they count as neither cleared nor new.
  readonly drifted: ReadonlyArray<{ readonly from: string; readonly to: string }>;
};

// One sector's holdouts against the entries the code produces for it now.
// An absent sector carries nothing, so every entry is unrecorded.
export const reconcileSector = (
  ledger: Ledger,
  sector: string,
  entries: Iterable<string>,
  unit: CampaignUnit,
): Reconciliation => {
  const holdouts = ledger.sectors[sector]?.holdouts ?? [];
  const known = new Set(holdouts);
  const ledgered: Array<string> = [];
  const unmatched: Array<string> = [];
  const current = new Set<string>();
  for (const entry of entries) {
    current.add(entry);
    if (known.has(entry)) ledgered.push(entry);
    else unmatched.push(entry);
  }
  let stale = holdouts.filter((entry) => !current.has(entry));
  const drifted: Array<{ from: string; to: string }> = [];
  const unrecorded: Array<string> = [];

  if (unit === "match") {
    // Pair each stale holdout with an unmatched entry under the same anchor,
    // in order, so a declaration with two edited matches keeps two entries.
    const byAnchor = new Map<string, Array<string>>();
    for (const entry of stale) {
      const anchor = anchorOf(entry);
      byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), entry]);
    }
    const paired = new Set<string>();
    for (const entry of unmatched) {
      const candidates = byAnchor.get(anchorOf(entry));
      const from = candidates?.shift();
      if (from === undefined) {
        unrecorded.push(entry);
        continue;
      }
      paired.add(from);
      drifted.push({ from, to: entry });
      ledgered.push(entry);
    }
    stale = stale.filter((entry) => !paired.has(entry));
  } else {
    for (const entry of unmatched) unrecorded.push(entry);
  }

  return { ledgered, unrecorded: sorted(unrecorded), stale, drifted };
};

// `clear` for one sector, in one of three positions: entering the window
// (recorded with its initial), inside it (stale holdouts leave, drifted
// ones are rewritten, and `lastCleared` moves only when something left),
// or past it (what still fires is `closed`, and the clock does not move).
export const clearedSector = (
  ledger: Ledger,
  sector: string,
  entries: Iterable<string>,
  unit: CampaignUnit,
  now: number,
  window: "inside" | "outside",
): Ledger => {
  const at = new Date(now).toISOString();
  const own = ledger.sectors[sector];
  if (window === "outside") {
    if (own === undefined || own.holdouts.length === 0) return ledger;
    return {
      ...ledger,
      sectors: {
        ...ledger.sectors,
        [sector]: { ...own, closed: own.closed + own.holdouts.length, holdouts: [] },
      },
    };
  }
  if (own === undefined) {
    const holdouts = sorted(entries);
    return {
      ...ledger,
      sectors: {
        ...ledger.sectors,
        [sector]: {
          entered: at,
          initial: holdouts.length,
          cleared: 0,
          closed: 0,
          lastCleared: at,
          holdouts,
        },
      },
    };
  }
  const { drifted, stale } = reconcileSector(ledger, sector, entries, unit);
  const rewritten = new Map(drifted.map((one) => [one.from, one.to]));
  const gone = new Set(stale);
  const holdouts = sorted(
    own.holdouts.filter((entry) => !gone.has(entry)).map((entry) => rewritten.get(entry) ?? entry),
  );
  return {
    ...ledger,
    sectors: {
      ...ledger.sectors,
      [sector]: {
        ...own,
        cleared: own.cleared + stale.length,
        lastCleared: stale.length > 0 ? at : own.lastCleared,
        holdouts,
      },
    },
  };
};

export type ConcessionRecord = {
  readonly at: number;
  readonly by: string;
  readonly reason: string;
};

// `concede`: the entries join the sector's holdouts, and a concession
// records that they did. The delta is what was actually added — an entry
// already present is not growth.
export const concededSector = (
  ledger: Ledger,
  sector: string,
  entries: Iterable<string>,
  record: ConcessionRecord,
): Ledger => {
  const own = ledger.sectors[sector];
  const present = new Set(own?.holdouts ?? []);
  const added = sorted([...entries].filter((entry) => !present.has(entry)));
  if (added.length === 0) return ledger;
  const at = new Date(record.at).toISOString();
  const base: SectorLedger = own ?? {
    entered: at,
    initial: 0,
    cleared: 0,
    closed: 0,
    lastCleared: at,
    holdouts: [],
  };
  return {
    ...ledger,
    sectors: {
      ...ledger.sectors,
      [sector]: { ...base, holdouts: sorted([...base.holdouts, ...added]) },
    },
    concessions: [
      ...ledger.concessions,
      { sector, at, by: record.by, delta: added.length, reason: record.reason, holdouts: added },
    ],
  };
};

// A re-baseline, authorized by a phase concession: the sector's holdouts
// become what the code produces now, and the concession records the count
// before and after with the phase concession's reason.
export const rebaselinedSector = (
  ledger: Ledger,
  sector: string,
  entries: Iterable<string>,
  record: ConcessionRecord,
): Ledger => {
  const own = ledger.sectors[sector];
  const holdouts = sorted(entries);
  const at = new Date(record.at).toISOString();
  const base: SectorLedger = own ?? {
    entered: at,
    initial: 0,
    cleared: 0,
    closed: 0,
    lastCleared: at,
    holdouts: [],
  };
  if (
    base.holdouts.length === holdouts.length &&
    base.holdouts.every((one, i) => one === holdouts[i])
  ) {
    return ledger;
  }
  return {
    ...ledger,
    sectors: { ...ledger.sectors, [sector]: { ...base, holdouts } },
    concessions: [
      ...ledger.concessions,
      {
        sector,
        at,
        by: record.by,
        from: base.holdouts.length,
        to: holdouts.length,
        reason: record.reason,
      },
    ],
  };
};

export const holdoutsOf = (ledger: Ledger): number =>
  Object.values(ledger.sectors).reduce((sum, one) => sum + one.holdouts.length, 0);

export const initialOf = (ledger: Ledger): number =>
  Object.values(ledger.sectors).reduce((sum, one) => sum + one.initial, 0);

export const clearedOf = (ledger: Ledger): number =>
  Object.values(ledger.sectors).reduce((sum, one) => sum + one.cleared, 0);

export const closedOf = (ledger: Ledger): number =>
  Object.values(ledger.sectors).reduce((sum, one) => sum + one.closed, 0);

// Growth conceded: every positive delta, the re-baselines included.
export const allowedOf = (ledger: Ledger): number =>
  ledger.concessions.reduce((sum, one) => sum + Math.max(0, deltaOf(one)), 0);

// `cleared / (initial + Σ delta − closed)`: how much of everything the
// objective was asked to pay down, and was not closed by a window shutting,
// has been paid.
export const progressOf = (ledger: Ledger): number => {
  const total =
    initialOf(ledger) +
    ledger.concessions.reduce((sum, one) => sum + deltaOf(one), 0) -
    closedOf(ledger);
  return total <= 0 ? 1 : 1 - holdoutsOf(ledger) / total;
};

export const isComplete = (ledger: Ledger): boolean => holdoutsOf(ledger) === 0;

export const lastClearedOf = (ledger: Ledger): string | null => {
  const stamps = Object.values(ledger.sectors).map((one) => one.lastCleared);
  return stamps.length === 0 ? null : stamps.reduce((a, b) => (a > b ? a : b));
};

// Stalled: holdouts remain, and nothing has left the ledger — nor, for a
// sector standing in an attested or open phase, been said about it —
// within the campaign's `staleAfter`. A campaign with none never stalls.
export const isStalled = (
  rule: { readonly staleAfter: number | null },
  ledger: Ledger,
  now: number,
  // The latest per-sector clock reading, when the host has the records.
  sectorClock: string | null = null,
): boolean => {
  if (rule.staleAfter === null || isComplete(ledger)) return false;
  const last = [lastClearedOf(ledger), sectorClock]
    .filter((one): one is string => one !== null)
    .reduce((a, b) => (a > b ? a : b), ledger.created);
  return now - Date.parse(last) > rule.staleAfter;
};

// ---------------------------------------------------------------------------
// The per-sector record: what derivation cannot say about a sector — the
// furthest phase it has reached, the phases attested for it, and the notes
// left for the next person or agent to touch it.

const Attestation = Schema.Struct({
  phase: Schema.String,
  reason: Schema.String,
  evidence: Schema.optionalKey(Schema.String),
  at: Schema.String,
  by: Schema.String,
});

const Note = Schema.Struct({
  at: Schema.String,
  by: Schema.String,
  // The phase the sector stood at when the note was left; a note under an
  // earlier phase leaves the nudge and stays in the file.
  phase: Schema.NullOr(Schema.String),
  text: Schema.String,
});

export const SectorRecord = Schema.Struct({
  version: Schema.Literal(1),
  campaign: Schema.String,
  sector: Schema.String,
  // The furthest phase ever derived for the sector, by id; `null` before
  // the first `clear` placed it.
  reached: Schema.NullOr(Schema.String),
  // When `reached` last advanced.
  since: Schema.String,
  attested: Schema.Array(Attestation),
  notes: Schema.Array(Note),
});

export type SectorRecord = typeof SectorRecord.Type;
export type Attestation = typeof Attestation.Type;
export type Note = typeof Note.Type;

const decodeRecord = Schema.decodeUnknownResult(SectorRecord, {
  errors: "all",
  onExcessProperty: "error",
});

export const decodeSectorRecord = (raw: unknown): Result.Result<SectorRecord, string> => {
  const decoded = decodeRecord(raw);
  return Result.isFailure(decoded)
    ? Result.fail(String(decoded.failure.issue))
    : Result.succeed(decoded.success);
};

export const serializeSectorRecord = (record: SectorRecord): string =>
  `${JSON.stringify(record, null, 2)}\n`;

export const EMPTY_SECTOR_RECORD = (
  campaign: string,
  sector: string,
  now: number,
): SectorRecord => ({
  version: 1,
  campaign,
  sector,
  reached: null,
  since: new Date(now).toISOString(),
  attested: [],
  notes: [],
});

// The record's position, as the phase logic reads it: `reached` as an index
// (`-1` when unplaced, or when the phase it names is gone).
export const positionOf = (
  rule: CompiledCampaign,
  record: SectorRecord | undefined,
): SectorPosition => ({
  reached:
    record?.reached === null || record === undefined
      ? -1
      : rule.phases.findIndex((phase) => phase.id === record.reached),
  attested: new Set(record?.attested.map((one) => one.phase) ?? []),
});

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

export const attestedRecord = (
  record: SectorRecord,
  entry: Omit<Attestation, "at"> & { readonly at: number },
): SectorRecord => ({
  ...record,
  attested: [...record.attested, { ...entry, at: new Date(entry.at).toISOString() }],
});

// Notes are capped — the last `NOTE_CAP`, each at most `NOTE_LENGTH`
// characters — since the file is reviewed like any other and the nudge
// hands them to an agent.
export const NOTE_CAP = 20;
export const NOTE_LENGTH = 500;

export const notedRecord = (
  record: SectorRecord,
  note: Omit<Note, "at"> & { readonly at: number },
): SectorRecord => ({
  ...record,
  notes: [
    ...record.notes,
    { ...note, text: note.text.slice(0, NOTE_LENGTH), at: new Date(note.at).toISOString() },
  ].slice(-NOTE_CAP),
});

// The sector's own clock: when it last advanced, or was attested or noted.
export const sectorClockOf = (record: SectorRecord): string =>
  [
    record.since,
    ...record.attested.map((one) => one.at),
    ...record.notes.map((one) => one.at),
  ].reduce((a, b) => (a > b ? a : b));

// ---------------------------------------------------------------------------
// The plan record: what `clear` last saw of the campaign's phases, so that
// `check` can tell a change to a defined phase (which needs a concession)
// from a refinement of an open one (which is free).

const PlanPhase = Schema.Struct({
  id: Schema.String,
  hash: Schema.String,
  defined: Schema.Boolean,
  concessions: Schema.Finite,
});

export const PlanRecord = Schema.Struct({
  version: Schema.Literal(1),
  campaign: Schema.String,
  phases: Schema.Array(PlanPhase),
});

export type PlanRecord = typeof PlanRecord.Type;

const decodePlan = Schema.decodeUnknownResult(PlanRecord, {
  errors: "all",
  onExcessProperty: "error",
});

export const decodePlanRecord = (raw: unknown): Result.Result<PlanRecord, string> => {
  const decoded = decodePlan(raw);
  return Result.isFailure(decoded)
    ? Result.fail(String(decoded.failure.issue))
    : Result.succeed(decoded.success);
};

export const serializePlanRecord = (record: PlanRecord): string =>
  `${JSON.stringify(record, null, 2)}\n`;

export const planOf = (rule: CompiledCampaign): PlanRecord => ({
  version: 1,
  campaign: rule.id,
  phases: rule.phases.map((phase) => ({
    id: phase.id,
    hash: phase.hash,
    defined: isDefinedPhase(phase),
    concessions: phase.concessions.length,
  })),
});

export type PlanDiff = {
  // Open phases that gained criteria, and phases that are new: free.
  readonly refined: ReadonlyArray<string>;
  // Defined phases whose definition changed, or that were removed.
  readonly changed: ReadonlyArray<string>;
  // Changed phases with no new concession — what fails `check`.
  readonly unreceipted: ReadonlyArray<string>;
};

export const planDiffOf = (rule: CompiledCampaign, recorded: PlanRecord | undefined): PlanDiff => {
  if (recorded === undefined) return { refined: [], changed: [], unreceipted: [] };
  const refined: Array<string> = [];
  const changed: Array<string> = [];
  const unreceipted: Array<string> = [];
  for (const phase of rule.phases) {
    const before = recorded.phases.find((one) => one.id === phase.id);
    if (before === undefined) {
      refined.push(phase.id);
      continue;
    }
    if (before.hash === phase.hash) continue;
    if (!before.defined) {
      refined.push(phase.id);
      continue;
    }
    changed.push(phase.id);
    if (phase.concessions.length <= before.concessions) unreceipted.push(phase.id);
  }
  for (const before of recorded.phases) {
    if (before.defined && !rule.phases.some((phase) => phase.id === before.id)) {
      changed.push(before.id);
      unreceipted.push(before.id);
    }
  }
  return { refined, changed, unreceipted };
};

// ---------------------------------------------------------------------------
// Where the files are, so both hosts agree.

export const ledgerPathOf = (dir: string, campaign: string, objective: string): string =>
  `${dir}/${campaign}/${objective}.json`;

// The family's first layout: one file per campaign.
export const legacyLedgerPathOf = (dir: string, campaign: string): string =>
  `${dir}/${campaign}.json`;

export const encodeSectorName = (sector: string): string => encodeURIComponent(sector);

export const sectorRecordPathOf = (dir: string, campaign: string, sector: string): string =>
  `${dir}/${campaign}/sectors/${encodeSectorName(sector)}.json`;

export const planPathOf = (dir: string, campaign: string): string => `${dir}/${campaign}/plan.json`;
