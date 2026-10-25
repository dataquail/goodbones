import type { BaseSide } from "../../base-side/base-side.value-object.js";

// Where the exact mode keeps what it evaluated a base tree to, by commit: a
// full tool run for a `report`-backed objective, worth keeping between runs.
// A side that is absent or unreadable is `null`, and is recomputed.
export type BaseSidesClient = {
  readonly read: (sha: string) => BaseSide | null;
  readonly write: (sha: string, side: BaseSide) => void;
};
