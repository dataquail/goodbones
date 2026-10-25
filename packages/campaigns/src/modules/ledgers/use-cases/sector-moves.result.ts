// A sector the working tree has carried to another phase than the one the
// ledgers placed it at: what the `clear` about to run will record. The
// defined phases strictly between the two were entered and left in that one
// clear — nothing in them was ever counted for the sector, which is worth
// saying: a phase every sector passes this way recognizes nothing.
export type SectorMove = {
  readonly campaign: string;
  readonly sector: string;
  readonly from: string | null;
  // `null` past every phase.
  readonly to: string | null;
  readonly back: boolean;
  readonly passed: ReadonlyArray<string>;
};
