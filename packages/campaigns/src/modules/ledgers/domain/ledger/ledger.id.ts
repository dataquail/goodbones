// Which ledger: an objective's, at `<ledgerDir>/<campaign>/<objective>.json`,
// or — `objective: null` — a campaign's in the family's first layout, one
// file per campaign at `<ledgerDir>/<campaign>.json`, which `clear` rewrites
// where it now belongs and removes.
export type LedgerId = {
  readonly campaign: string;
  readonly objective: string | null;
};
