import * as Result from "effect/Result";

import type { SectorRecordsRepository } from "../../domain/ports/repositories/sector-records.repository.js";
import { SectorRecordUnreadable } from "../../domain/sector-record/sector-record.errors.js";
import type { SectorRecord } from "../../domain/sector-record/sector-record.root.js";
import { parseJson } from "./ledger.mapper.js";
import { type LedgerStore, writeStoredFile } from "./objective-ledgers.repository-live.js";
import {
  decodeSectorRecord,
  sectorRecordPathOf,
  serializeSectorRecord,
} from "./sector-record.mapper.js";

export const makeSectorRecordsRepositoryLive = ({
  fileSystem,
  ledgerDir,
  repoRoot,
}: LedgerStore): SectorRecordsRepository => {
  // The record at `at`, refused when it is not JSON, not a record, or
  // another campaign's; `null` when there is no file.
  const readAt = (
    at: string,
    campaign: string,
  ): Result.Result<SectorRecord | null, SectorRecordUnreadable> => {
    const text = fileSystem.readText(at);

    if (text === null) return Result.succeed(null);

    const refuse = (reason: SectorRecordUnreadable["reason"], detail: string) =>
      Result.fail(new SectorRecordUnreadable({ at, reason, detail }));

    const raw = parseJson(text);

    if (Result.isFailure(raw)) return refuse("not-json", raw.failure);
    const decoded = decodeSectorRecord(raw.success);

    if (Result.isFailure(decoded)) return refuse("undecodable", decoded.failure);

    if (decoded.success.campaign !== campaign) {
      return refuse("misplaced", decoded.success.campaign);
    }

    return Result.succeed(decoded.success);
  };

  return {
    findOne: ({ campaign, sector }) =>
      readAt(sectorRecordPathOf(ledgerDir, campaign, sector), campaign),
    findAll: (campaign) => {
      const dir = `${ledgerDir}/${campaign}/sectors`;
      const records: Array<SectorRecord> = [];

      for (const name of fileSystem.list(dir)) {
        if (!name.endsWith(".json")) continue;
        const found = readAt(`${dir}/${name}`, campaign);

        if (Result.isFailure(found)) return Result.fail(found.failure);

        if (found.success !== null) records.push(found.success);
      }

      return Result.succeed(records);
    },
    save: (record) => {
      writeStoredFile(
        repoRoot,
        sectorRecordPathOf(ledgerDir, record.campaign, record.sector),
        serializeSectorRecord(record),
      );
    },
  };
};
