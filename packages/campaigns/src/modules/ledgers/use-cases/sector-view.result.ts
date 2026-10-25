import type { Residue as ResidueVector } from "../../../core/phases.js";

// Where one sector stands and what holds it there.
export type SectorView = {
  readonly campaign: string;
  readonly sector: string;
  readonly phase: {
    readonly id: string | null;
    readonly index: number;
    readonly of: number;
    readonly open: boolean;
    readonly attested: boolean;
    readonly intent: string | null;
  };
  // The furthest phase the record says it reached, and since when.
  readonly reached: string | null;
  readonly since: string | null;
  readonly attestations: ReadonlyArray<{
    readonly phase: string;
    readonly at: string;
    readonly by: string;
    readonly reason: string;
    // A concession that sent the sector back below the phase revoked it.
    readonly revoked: { readonly at: string; readonly by: string; readonly reason: string } | null;
  }>;
  readonly toward: ResidueVector;
  // Every holdout in window, by objective, with the objective's `how`.
  readonly objectives: ReadonlyArray<{
    readonly id: string;
    readonly how: string;
    readonly count: number;
    readonly holdouts: ReadonlyArray<{
      readonly file: string | null;
      readonly line: number | null;
      readonly subject: string | null;
    }>;
  }>;
  // The scalar objectives in window: the value, and what the ledger holds
  // the sector to.
  readonly measures: ReadonlyArray<{
    readonly objective: string;
    readonly value: number | null;
    readonly recorded: number | null;
    readonly target: number | null;
    readonly tolerance: number;
  }>;
  readonly notes: ReadonlyArray<{ at: string; by: string; phase: string | null; text: string }>;
};
