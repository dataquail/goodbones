import type * as Result from "effect/Result";

import type { SectorRecordUnreadable } from "../../sector-record/sector-record.errors.js";
import type { SectorRecord } from "../../sector-record/sector-record.root.js";

// A campaign's per-sector records, every one there is, in the order their
// files sort. A malformed record, or one of another campaign, is refused.
export type SectorRecordsRepository = {
  readonly findAll: (
    campaign: string,
  ) => Result.Result<ReadonlyArray<SectorRecord>, SectorRecordUnreadable>;
  readonly save: (record: SectorRecord) => void;
};
