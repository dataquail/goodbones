import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import type { FileSystem } from "@goodbones/core";
import * as Result from "effect/Result";

import { LedgerUnreadable } from "../../domain/ledger/ledger.errors.js";
import type { Ledger } from "../../domain/ledger/ledger.root.js";
import type { MeasureLedger } from "../../domain/measure-ledger/measure-ledger.root.js";
import type { ObjectiveLedgersRepository } from "../../domain/ports/repositories/objective-ledgers.repository.js";
import {
  decodeLedger,
  decodeMeasureLedger,
  isLegacyLedger,
  isMeasureLedger,
  ledgerPathOf,
  legacyLedgerPathOf,
  parseJson,
  serializeLedger,
  serializeMeasureLedger,
} from "./ledger.mapper.js";

// Where the ledger directory is, and how it is read. Reads go through the
// host's file system port, so a lint run and the browser read the ledgers as
// they read any file; writes go to disk under the repository root.
export type LedgerStore = {
  readonly fileSystem: FileSystem;
  readonly repoRoot: string;
  // Repo-relative.
  readonly ledgerDir: string;
};

export const writeStoredFile = (repoRoot: string, at: string, text: string): void => {
  const absolute = path.resolve(repoRoot, at);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
};

export const makeObjectiveLedgersRepositoryLive = ({
  fileSystem,
  ledgerDir,
  repoRoot,
}: LedgerStore): ObjectiveLedgersRepository => {
  const pathOf = (campaign: string, objective: string | null): string =>
    objective === null
      ? legacyLedgerPathOf(ledgerDir, campaign)
      : ledgerPathOf(ledgerDir, campaign, objective);

  return {
    findOne: ({ campaign, objective }) => {
      const at = pathOf(campaign, objective);
      const text = fileSystem.readText(at);

      if (text === null) return Result.succeed(null);

      const refuse = (
        reason: LedgerUnreadable["reason"],
        detail: string,
        measure: boolean,
      ): Result.Result<never, LedgerUnreadable> =>
        Result.fail(new LedgerUnreadable({ at, reason, detail, measure }));

      const raw = parseJson(text);

      if (Result.isFailure(raw)) return refuse("not-json", raw.failure, false);
      const measure = isMeasureLedger(raw.success);

      if (objective === null && !isLegacyLedger(raw.success)) {
        return refuse("not-first-layout", "", measure);
      }

      const decoded: Result.Result<Ledger | MeasureLedger, string> = measure
        ? decodeMeasureLedger(raw.success)
        : decodeLedger(raw.success);

      if (Result.isFailure(decoded)) return refuse("undecodable", decoded.failure, measure);
      const ledger = decoded.success;

      // A first-layout ledger is its campaign's, and names the campaign as
      // its objective.
      if (ledger.campaign !== campaign || ledger.objective !== (objective ?? campaign)) {
        return refuse("misplaced", `${ledger.campaign}/${ledger.objective}`, measure);
      }

      return Result.succeed(ledger);
    },
    save: (ledger) => {
      writeStoredFile(
        repoRoot,
        pathOf(ledger.campaign, ledger.objective),
        "kind" in ledger ? serializeMeasureLedger(ledger) : serializeLedger(ledger),
      );
    },
    remove: ({ campaign, objective }) => {
      rmSync(path.resolve(repoRoot, pathOf(campaign, objective)), { force: true });
    },
  };
};
