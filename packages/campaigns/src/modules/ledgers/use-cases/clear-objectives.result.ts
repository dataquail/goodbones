// What `objectives clear` did to one objective's ledger.
export type ClearOutcome = {
  readonly campaign: string;
  readonly objective: string;
  readonly cleared: number;
  readonly rewritten: number;
  readonly closed: number;
  readonly entered: ReadonlyArray<string>;
  readonly rebaselined: ReadonlyArray<string>;
  readonly left: number;
  // For a scalar objective: the sectors whose record improved, those whose
  // number rose in a phase that `grows` it, and what the open sectors are
  // held to now, summed. `cleared`, `rewritten` and `left` are 0; `closed`
  // counts sectors.
  readonly measure?: {
    readonly improved: ReadonlyArray<{ sector: string; from: number; to: number }>;
    // `phase` is `null` on the shared files, which hold no number.
    readonly grown: ReadonlyArray<{
      sector: string;
      from: number;
      to: number;
      phase: string | null;
    }>;
    readonly recorded: number;
  };
};
