import * as Result from "effect/Result";

import type { SectorRecordsRepository } from "../../domain/ports/repositories/sector-records.repository.js";
import type { SectorRecord } from "../../domain/sector-record/sector-record.root.js";

export type SectorRecordsRepositoryFake = SectorRecordsRepository & {
  // What the repository holds now, keyed `<campaign>/<sector>`.
  readonly stored: ReadonlyMap<string, SectorRecord>;
};

const keyOf = (record: SectorRecord): string => `${record.campaign}/${record.sector}`;

// In memory, the records of a campaign in the order of their sectors' names.
export const makeSectorRecordsRepositoryFake = (
  seed: ReadonlyArray<SectorRecord> = [],
): SectorRecordsRepositoryFake => {
  const stored = new Map(seed.map((one) => [keyOf(one), one] as const));

  return {
    stored,
    findOne: ({ campaign, sector }) => Result.succeed(stored.get(`${campaign}/${sector}`) ?? null),
    findAll: (campaign) =>
      Result.succeed(
        [...stored.values()]
          .filter((one) => one.campaign === campaign)
          .sort((a, b) => (a.sector < b.sector ? -1 : a.sector > b.sector ? 1 : 0)),
      ),
    save: (record) => {
      stored.set(keyOf(record), record);
    },
  };
};
