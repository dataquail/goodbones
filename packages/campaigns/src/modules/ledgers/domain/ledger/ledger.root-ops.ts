import type { CampaignUnit } from "../../../../domain/config.js";
import type { Concession, Ledger, SectorLedger } from "./ledger.root.js";

// What may happen to an objective's ledger, and what it says: reconciled
// against the code by `clear`, grown only by `concede` or a receipted
// re-baseline, and read for its arithmetic, its progress and its clock.

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

// The same entry under another anchor: a rename of the declaration around
// a match changes the anchor and leaves the file and the text — so the hash,
// and the ordinal a duplicate carries — where they were.
const contentOf = (entry: string): string | null => {
  const first = entry.indexOf("#");
  const last = entry.lastIndexOf("#");

  return first === -1 || first === last
    ? null
    : `${entry.slice(0, first)}#${entry.slice(last + 1)}`;
};

export type Reconciliation = {
  // Entries the ledger already carries, exactly, by anchor or by content.
  readonly ledgered: ReadonlyArray<string>;
  // Entries the ledger does not carry: unrecorded growth.
  readonly unrecorded: ReadonlyArray<string>;
  // Holdouts no entry produces: cleared, and waiting for `clear`.
  readonly stale: ReadonlyArray<string>;
  // Holdouts that moved — a new hash under a still-present anchor, or the
  // same text under a renamed one — with what they read now. `clear`
  // rewrites them; they count as neither cleared nor new.
  readonly drifted: ReadonlyArray<{ readonly from: string; readonly to: string }>;
};

// One sector's holdouts against the entries the code produces for it now.
// An absent sector carries nothing, so every entry is unrecorded.
export const reconcileSector = (
  ledger: Ledger,
  sector: string,
  entries: Iterable<string>,
  unit: CampaignUnit,
): Reconciliation => reconcileEntries(ledger.sectors[sector]?.holdouts ?? [], entries, unit);

// Holdouts known before against the entries produced now — a ledger's, or
// a base tree's.
export const reconcileEntries = (
  holdouts: ReadonlyArray<string>,
  entries: Iterable<string>,
  unit: CampaignUnit,
): Reconciliation => {
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
  let unrecorded: Array<string> = [];

  if (unit === "match") {
    // Pair each stale holdout with an unmatched entry under the same anchor,
    // in order, so a declaration with two edited matches keeps two entries;
    // then what is left by its content, across anchors, so a renamed
    // declaration keeps its holdouts.
    const pass = (
      keyOf: (entry: string) => string | null,
      candidates: ReadonlyArray<string>,
    ): Array<string> => {
      const byKey = new Map<string, Array<string>>();

      for (const entry of stale) {
        const key = keyOf(entry);

        if (key !== null) byKey.set(key, [...(byKey.get(key) ?? []), entry]);
      }

      const paired = new Set<string>();
      const left: Array<string> = [];

      for (const entry of candidates) {
        const key = keyOf(entry);
        const from = key === null ? undefined : byKey.get(key)?.shift();

        if (from === undefined) {
          left.push(entry);
          continue;
        }

        paired.add(from);
        drifted.push({ from, to: entry });
        ledgered.push(entry);
      }

      stale = stale.filter((entry) => !paired.has(entry));

      return left;
    };

    unrecorded = pass(contentOf, pass(anchorOf, unmatched));
  } else {
    unrecorded = unmatched;
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

// One sector's share of an objective paid: what `clear` removed over
// everything the sector was ever asked to pay there. `0` for a sector the
// ledger has not recorded, `1` for one that entered with nothing to pay.
export const sectorProgressOf = (ledger: Ledger | undefined, sector: string): number => {
  const own = ledger?.sectors[sector];

  if (own === undefined) return 0;
  const total = own.cleared + own.holdouts.length;

  return total <= 0 ? 1 : own.cleared / total;
};

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

export const LedgerRootOps = {
  deltaOf,
  sectorArithmeticHolds,
  ledgerArithmeticHolds,
  reconcileSector,
  reconcileEntries,
  clearedSector,
  concededSector,
  rebaselinedSector,
  holdoutsOf,
  initialOf,
  clearedOf,
  closedOf,
  allowedOf,
  progressOf,
  isComplete,
  sectorProgressOf,
  lastClearedOf,
  isStalled,
} as const;
