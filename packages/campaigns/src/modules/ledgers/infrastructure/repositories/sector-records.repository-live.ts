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
}: LedgerStore): SectorRecordsRepository => ({
  findAll: (campaign) => {
    const dir = `${ledgerDir}/${campaign}/sectors`;
    const records: Array<SectorRecord> = [];

    for (const name of fileSystem.list(dir)) {
      if (!name.endsWith(".json")) continue;
      const at = `${dir}/${name}`;
      const text = fileSystem.readText(at);

      if (text === null) continue;

      const refuse = (reason: SectorRecordUnreadable["reason"], detail: string) =>
        Result.fail(new SectorRecordUnreadable({ at, reason, detail }));

      const raw = parseJson(text);

      if (Result.isFailure(raw)) return refuse("not-json", raw.failure);
      const decoded = decodeSectorRecord(raw.success);

      if (Result.isFailure(decoded)) return refuse("undecodable", decoded.failure);

      if (decoded.success.campaign !== campaign) {
        return refuse("misplaced", decoded.success.campaign);
      }

      records.push(decoded.success);
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
});
