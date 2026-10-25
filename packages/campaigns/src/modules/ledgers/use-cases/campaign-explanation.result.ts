// What `explain` says of one campaign for one file: the sector the file is
// in, the phase it stands at, the objectives in window and which fire here,
// the scalars' numbers, and the holdouts in this file.
export type CampaignExplanation = {
  readonly campaign: { readonly id: string; readonly name: string; readonly phases: number };
  readonly sector: string;
  // The campaign's shared files: held by every sector, on no phase.
  readonly shared: boolean;
  // Where the sector stands; `phase` is `null` past every phase.
  readonly index: number;
  readonly phase: {
    readonly id: string;
    readonly open: boolean;
    readonly attested: boolean;
    readonly intent: string | null;
  } | null;
  readonly reached: string | null;
  readonly inWindow: ReadonlyArray<{ readonly id: string; readonly firing: boolean }>;
  // `value` is `NaN` for no number; `recorded` is `null` while unrecorded.
  readonly measures: ReadonlyArray<{
    readonly id: string;
    readonly value: number;
    readonly recorded: number | null;
    readonly target: number | null;
  }>;
  // Nearest first, every one: the presenter caps them.
  readonly holdouts: ReadonlyArray<{
    readonly line: number | null;
    readonly objective: string;
    readonly subject: string | null;
  }>;
};
