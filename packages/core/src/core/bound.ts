// A number held to a limit from one side: a coverage floor (`up`, the value
// may not fall under it), a conformance ceiling (`down`, it may not rise over
// it), or a campaign's scalar objective, whose limit is the value its ledger
// last recorded. One comparison for all three, so "coverage ≥ N" has one
// meaning whether the manifest owns the number or a ledger does.

export type BoundDirection = "down" | "up";

export type Bound = {
  // Which way is better: `down` for a ceiling, `up` for a floor.
  readonly direction: BoundDirection;
  readonly limit: number;
  // How far past the limit, either way, still counts as at it.
  readonly tolerance: number;
};

// `breached`: worse than the limit by more than the tolerance. `surpassed`:
// better by more than it. `within`: neither.
export type Standing = "within" | "breached" | "surpassed";

// How much worse than the limit the value is — negative when better.
export const shortfallOf = (bound: Bound, value: number): number =>
  bound.direction === "down" ? value - bound.limit : bound.limit - value;

export const standingOf = (bound: Bound, value: number): Standing => {
  const worse = shortfallOf(bound, value);
  if (worse > bound.tolerance) return "breached";
  if (-worse > bound.tolerance) return "surpassed";
  return "within";
};

export const breaches = (bound: Bound, value: number): boolean =>
  standingOf(bound, value) === "breached";
