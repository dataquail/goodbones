import type * as Result from "effect/Result";

import type { SectorRecordUnreadable } from "../../sector-record/sector-record.errors.js";
import type { SectorRecord } from "../../sector-record/sector-record.root.js";

// A campaign's per-sector records, every one there is, in the order their
// files sort, or one sector's — `null` when no `clear` has placed it. A
// malformed record, or one of another campaign, is refused.
export type SectorRecordsRepository = {
  readonly findOne: (id: {
    readonly campaign: string;
    readonly sector: string;
  }) => Result.Result<SectorRecord | null, SectorRecordUnreadable>;
  readonly findAll: (
    campaign: string,
  ) => Result.Result<ReadonlyArray<SectorRecord>, SectorRecordUnreadable>;
  readonly save: (record: SectorRecord) => void;
};
