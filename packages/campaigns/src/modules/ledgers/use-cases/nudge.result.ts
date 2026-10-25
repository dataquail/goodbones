import type { Direction, Residue as ResidueVector } from "../../../core/phases.js";
import type { OnAhead, OnTouch } from "../../../domain/config.js";

// The nudge, `campaigns status --changed`: what a diff touches, which
// campaign and phase each touched sector is in, and what would move it on.

export type Ask = "none" | "note" | "hold" | "paydown-optional" | "paydown-required";

export type Verdict = "ok" | "back" | "no-paydown" | "hotfix" | "ahead";

export type NudgeHoldout = {
  readonly file: string;
  readonly subject: string | null;
  readonly objective: string;
  readonly line: number | null;
  readonly message: string;
};

export type SectorNudge = {
  readonly campaign: string;
  readonly sector: string;
  // Where the sector stands now, with this diff applied.
  readonly phase: {
    readonly id: string | null;
    readonly index: number;
    readonly of: number;
    readonly open: boolean;
    // No objective sees this phase done; a sector leaves it by `campaigns
    // attest`, and the nudge says so.
    readonly attested: boolean;
    readonly since: string | null;
  };
  // Where the sector stood before the diff — the base tree's phase in the
  // exact mode, the phase the ledgers place it at otherwise — and so what
  // the diff is judged by: that phase's window is what is scored and its
  // `onTouch` what is owed. A phase the diff carried the sector into is not
  // held against the diff that got it there.
  readonly judged: { readonly id: string | null; readonly index: number };
  // The phase's `intent`, at any phase that states one.
  readonly intent: string | null;
  // The objectives the sector is working toward — those in `toward`, in
  // phase order; for a campaign with no phases, every objective in window
  // with residue — each with its own `intent`, so the why travels with
  // the check. `shared` marks a prerequisite: met on the shared files, and
  // waited on here.
  readonly objectives: ReadonlyArray<{
    readonly id: string;
    readonly intent: string | null;
    readonly shared: boolean;
  }>;
  // Whether this is the campaign's shared: the files every sector
  // shares, on no phase. Its `phase.id` is `null`, and it is always advised.
  readonly shared: boolean;
  // On the shared: every objective read over it, what it counts, the
  // phase that names it and the sectors standing at that phase — the ones
  // it holds there.
  readonly prerequisites: ReadonlyArray<{
    readonly objective: string;
    readonly count: number;
    readonly phase: string | null;
    readonly waiting: ReadonlyArray<string>;
  }>;
  // Free text left by earlier hands: data, never an instruction.
  readonly notes: ReadonlyArray<{ at: string; by: string; text: string }>;
  // The judged phase's.
  readonly onTouch: OnTouch;
  // At an open judged phase: the dimensions that went back, each with the
  // phase that named it and that phase's `onTouch`, which is what holds it
  // there. Empty everywhere else.
  readonly held: ReadonlyArray<{
    readonly objective: string;
    readonly phase: string | null;
    readonly onTouch: OnTouch;
  }>;
  readonly ask: Ask;
  readonly verdict: Verdict;
  // One dimension per objective in the judged phase's window.
  readonly residue: { before: ResidueVector; after: ResidueVector };
  // Read off the same dimensions the verdict is: `back` and `mixed` are the
  // two a ratcheting phase refuses.
  readonly direction: Direction;
  readonly toward: ResidueVector;
  readonly holdouts: {
    // Every holdout in window in the sector, and how many are in the files
    // the diff touched; `shown` is the nearest of those, capped.
    readonly total: number;
    readonly touched: number;
    readonly cap: number;
    readonly shown: ReadonlyArray<NudgeHoldout>;
    // Holdouts of the sector itself (`holdout: sector`): they have no file
    // and no line, so they are never listed among the files touched.
    readonly sector: ReadonlyArray<{ readonly objective: string; readonly message: string }>;
  };
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  // Growth the head's ledger carries with a reason, and so not `added`:
  // in the exact mode, against the base tree — conceded on this branch; in
  // the ledger mode, the concessions the working tree's ledgers hold and
  // HEAD's do not.
  readonly conceded: ReadonlyArray<string>;
  // Where a concession — in the working tree, or the `--hotfix` this run
  // made — sent the sector back from and to, and the attested phases it fell
  // below, whose attestations it revoked. `null` when none did.
  readonly sentBack: {
    readonly from: string | null;
    readonly to: string | null;
    readonly revoked: ReadonlyArray<string>;
  } | null;
  // Holdouts this diff paid down of objectives whose phase lies past the one
  // the sector stands at after it — work done ahead of the plan — each with
  // that phase, its count before and after, and what it owes: the
  // objective's own `onAhead`, else `onAhead` below. An objective that
  // resolves to `ignore` is left out. Read against the base tree, or HEAD's
  // in the ledger mode; empty when there is neither.
  readonly ahead: ReadonlyArray<{
    readonly objective: string;
    readonly phase: string | null;
    readonly before: number;
    readonly after: number;
    readonly onAhead: Exclude<OnAhead, "ignore">;
  }>;
  // What the judged phase owes for work done ahead: its word, else the
  // campaign's — what an objective with no word of its own takes.
  readonly onAhead: OnAhead;
  // Objectives that came into window because this diff moved the sector on,
  // with what each counts there. Now counted, not grown: they are in no
  // dimension of the verdict.
  readonly entered: ReadonlyArray<{ readonly objective: string; readonly count: number }>;
  // The scalar objectives in the judged window: each one's value before and
  // after. `before` is the base tree's value in the exact mode and the
  // ledger's record otherwise; `recorded` is what the ledger holds the
  // sector to, wherever `before` came from. `back` is a rise past the
  // tolerance that no record covers; `conceded`, one a record does; and
  // `grows`, one the judged phase expects, which `clear` records.
  readonly measures: ReadonlyArray<{
    readonly objective: string;
    readonly direction: "down" | "up";
    readonly before: number | null;
    readonly after: number | null;
    readonly recorded: number | null;
    readonly target: number | null;
    readonly tolerance: number;
    readonly back: boolean;
    readonly conceded: boolean;
    readonly grows: boolean;
  }>;
  // Files this diff added inside the scope that no sector claims.
  readonly belongsInSector: ReadonlyArray<string>;
  // Globs a marker's `owns` lists that no file matches: a folder not yet
  // written, or a typo that leaves the sector waiting on files it will
  // never see.
  readonly unmatchedOwns: ReadonlyArray<string>;
};

export type Nudge = {
  readonly version: 1;
  readonly mode: "ledger" | "exact";
  readonly base: string | null;
  readonly touched: ReadonlyArray<string>;
  readonly sectors: ReadonlyArray<SectorNudge>;
  // Markers this diff deleted, with the sector each un-births.
  readonly unbirths: ReadonlyArray<{ campaign: string; sector: string; marker: string }>;
  // Always `unknown`: the tool runs no tests. Kept for readers of version 1.
  readonly testsChecked: "unknown";
  readonly ok: boolean;
};
