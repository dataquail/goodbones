import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { CampaignUnit } from "../domain/architecture-config.js";
import type { Violation } from "../domain/violation.js";

// A campaign's ledger: every place the pattern still occurs, and the record of
// every time the count was allowed to go up. It is the baseline's cousin and
// not the baseline — same fingerprint, different file, different semantics.
//
//   - One file per campaign, so two pull requests migrating different
//     components never conflict, and finishing a campaign is deleting its file.
//   - Growth is only ever recorded, never silent. `prune` only removes;
//     `allow` is the one way an entry is added, and it always appends a
//     regression with a reason, a timestamp and an author.
//   - The arithmetic is checked: `entries.length === initial + Σ delta − fixed`.
//     A hand-added entry with no regression record fails the build, with no
//     git history in the loop.
//   - A fixed entry is stale, and `check` fails on it as it fails on a stale
//     baseline entry, so progress lands as a visible diff.

const Regression = Schema.Struct({
  at: Schema.String,
  by: Schema.String,
  delta: Schema.Finite,
  reason: Schema.String,
  entries: Schema.Array(Schema.String),
});

export const Ledger = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  created: Schema.String,
  // The count on the day the ledger was written.
  initial: Schema.Finite,
  // Entries removed by `prune` since.
  fixed: Schema.Finite,
  // When an entry last left the ledger — what the stall clock reads.
  lastProgress: Schema.String,
  regressions: Schema.Array(Regression),
  // `file` or `file#subject`, deduplicated and sorted.
  entries: Schema.Array(Schema.String),
});

export type Ledger = typeof Ledger.Type;
export type Regression = typeof Regression.Type;

const decode = Schema.decodeUnknownResult(Ledger, { errors: "all", onExcessProperty: "error" });

export const EMPTY_LEDGER = (id: string, now: number): Ledger => {
  const at = new Date(now).toISOString();
  return {
    version: 1,
    id,
    created: at,
    initial: 0,
    fixed: 0,
    lastProgress: at,
    regressions: [],
    entries: [],
  };
};

// A malformed ledger is refused, unlike a malformed baseline, which reads as
// empty: an empty baseline reports every violation, the safe direction, while
// an empty ledger would report every hit as unrecorded growth and demand a
// regression record for debt that was already counted.
export const decodeLedger = (raw: unknown): Result.Result<Ledger, string> => {
  const decoded = decode(raw);
  return Result.isFailure(decoded)
    ? Result.fail(String(decoded.failure.issue))
    : Result.succeed(decoded.success);
};

export const serializeLedger = (ledger: Ledger): string => `${JSON.stringify(ledger, null, 2)}\n`;

// A hit's entry: the file, and its subject when the campaign's unit has one.
export const entryOf = (violation: Violation): string =>
  violation.subject === null ? violation.file : `${violation.file}#${violation.subject}`;

const allowedTotal = (ledger: Ledger): number =>
  ledger.initial + ledger.regressions.reduce((sum, one) => sum + one.delta, 0);

export const ledgerArithmeticHolds = (ledger: Ledger): boolean =>
  ledger.entries.length === allowedTotal(ledger) - ledger.fixed;

// A `match` entry is `file#anchor#hash`; an edit inside the anchored
// declaration changes the hash and nothing else, and is the same entry.
const anchorOf = (entry: string): string => entry.slice(0, entry.lastIndexOf("#"));

export type Reconciliation = {
  // Hits the ledger already carries, exactly or by anchor.
  readonly ledgered: ReadonlyArray<Violation>;
  // Hits the ledger does not carry: unrecorded growth.
  readonly unrecorded: ReadonlyArray<Violation>;
  // Entries no hit produces: fixed, and waiting to be pruned.
  readonly stale: ReadonlyArray<string>;
  // Entries whose hash moved under a still-present anchor, with what they
  // read now. `prune` rewrites them; they count as neither fixed nor new.
  readonly drifted: ReadonlyArray<{ readonly from: string; readonly to: string }>;
};

export const reconcile = (
  ledger: Ledger,
  hits: Iterable<Violation>,
  unit: CampaignUnit,
): Reconciliation => {
  const entries = new Set(ledger.entries);
  const ledgered: Array<Violation> = [];
  const unmatched: Array<Violation> = [];
  const current = new Set<string>();
  for (const hit of hits) {
    const entry = entryOf(hit);
    current.add(entry);
    if (entries.has(entry)) ledgered.push(hit);
    else unmatched.push(hit);
  }
  let stale = ledger.entries.filter((entry) => !current.has(entry));
  const drifted: Array<{ from: string; to: string }> = [];
  const unrecorded: Array<Violation> = [];

  if (unit === "match") {
    // Pair each stale entry with an unmatched hit under the same anchor, in
    // order, so a declaration with two edited matches keeps two entries.
    const byAnchor = new Map<string, Array<string>>();
    for (const entry of stale) {
      const anchor = anchorOf(entry);
      byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), entry]);
    }
    const paired = new Set<string>();
    for (const hit of unmatched) {
      const entry = entryOf(hit);
      const candidates = byAnchor.get(anchorOf(entry));
      const from = candidates?.shift();
      if (from === undefined) {
        unrecorded.push(hit);
        continue;
      }
      paired.add(from);
      drifted.push({ from, to: entry });
      ledgered.push(hit);
    }
    stale = stale.filter((entry) => !paired.has(entry));
  } else {
    for (const hit of unmatched) unrecorded.push(hit);
  }

  return { ledgered, unrecorded, stale, drifted };
};

export const staleEntriesOf = (
  ledger: Ledger,
  hits: Iterable<Violation>,
  unit: CampaignUnit,
): ReadonlyArray<string> => reconcile(ledger, hits, unit).stale;

export const newEntriesOf = (
  ledger: Ledger,
  hits: Iterable<Violation>,
  unit: CampaignUnit,
): ReadonlyArray<string> => reconcile(ledger, hits, unit).unrecorded.map(entryOf);

const sorted = (entries: Iterable<string>): ReadonlyArray<string> => [...new Set(entries)].sort();

// A first ledger: every hit is an entry, and the count is the `initial`.
export const ledgerOf = (id: string, hits: Iterable<Violation>, now: number): Ledger => {
  const entries = sorted([...hits].map(entryOf));
  return { ...EMPTY_LEDGER(id, now), initial: entries.length, entries };
};

// `prune`: the stale entries leave, `fixed` rises by as many, and
// `lastProgress` moves — only when something left. A drifted entry is
// rewritten in place and counts as neither.
export const pruned = (
  ledger: Ledger,
  hits: Iterable<Violation>,
  unit: CampaignUnit,
  now: number,
): Ledger => {
  const { drifted, stale } = reconcile(ledger, hits, unit);
  const rewritten = new Map(drifted.map((one) => [one.from, one.to]));
  const gone = new Set(stale);
  const entries = sorted(
    ledger.entries
      .filter((entry) => !gone.has(entry))
      .map((entry) => rewritten.get(entry) ?? entry),
  );
  return {
    ...ledger,
    fixed: ledger.fixed + stale.length,
    lastProgress: stale.length > 0 ? new Date(now).toISOString() : ledger.lastProgress,
    entries,
  };
};

export type RegressionRecord = {
  readonly at: number;
  readonly by: string;
  readonly reason: string;
};

// `allow`: the entries join the ledger, and a regression records that they
// did. The delta is what was actually added — an entry already present is
// not growth.
export const allowed = (
  ledger: Ledger,
  entries: Iterable<string>,
  record: RegressionRecord,
): Ledger => {
  const present = new Set(ledger.entries);
  const added = sorted([...entries].filter((entry) => !present.has(entry)));
  if (added.length === 0) return ledger;
  return {
    ...ledger,
    regressions: [
      ...ledger.regressions,
      {
        at: new Date(record.at).toISOString(),
        by: record.by,
        delta: added.length,
        reason: record.reason,
        entries: added,
      },
    ],
    entries: sorted([...ledger.entries, ...added]),
  };
};

// `1 − count / (initial + Σ delta)`: how much of everything the campaign was
// ever asked to pay down has been paid.
export const progressOf = (ledger: Ledger): number => {
  const total = allowedTotal(ledger);
  return total === 0 ? 1 : 1 - ledger.entries.length / total;
};

export const isComplete = (ledger: Ledger): boolean => ledger.entries.length === 0;

export const isStalled = (
  rule: { readonly staleAfter: number },
  ledger: Ledger,
  now: number,
): boolean => !isComplete(ledger) && now - Date.parse(ledger.lastProgress) > rule.staleAfter;
