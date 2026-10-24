import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { SectorRecord } from "../../domain/sector-record/sector-record.root.js";

// Sector records as `<ledgerDir>/<campaign>/sectors/<sector>.json` keeps
// them, the sector's name URI-encoded so any name is a file name.

const decodeRecord = Schema.decodeUnknownResult(SectorRecord, {
  errors: "all",
  onExcessProperty: "error",
  reportInput: true,
});

export const decodeSectorRecord = (raw: unknown): Result.Result<SectorRecord, string> => {
  const decoded = decodeRecord(raw);

  return Result.isFailure(decoded)
    ? Result.fail(String(decoded.failure.issue))
    : Result.succeed(decoded.success);
};

export const serializeSectorRecord = (record: SectorRecord): string =>
  `${JSON.stringify(record, null, 2)}\n`;

export const encodeSectorName = (sector: string): string => encodeURIComponent(sector);

export const sectorRecordPathOf = (dir: string, campaign: string, sector: string): string =>
  `${dir}/${campaign}/sectors/${encodeSectorName(sector)}.json`;
