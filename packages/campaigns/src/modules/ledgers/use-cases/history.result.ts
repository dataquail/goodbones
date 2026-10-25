export type HistoryRow = {
  readonly sha: string;
  readonly at: string;
  readonly subject: string;
  // Holdouts per objective, as the ledgers stood after the commit; for a
  // scalar, the value its open sectors were held to.
  readonly counts: Readonly<Record<string, number>>;
  readonly planChanged: boolean;
};
