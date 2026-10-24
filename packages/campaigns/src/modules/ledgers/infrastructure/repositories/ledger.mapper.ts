import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { IMPLICIT_SECTOR } from "../../../../core/sectors.js";
import { Ledger } from "../../domain/ledger/ledger.root.js";
import { MeasureLedger } from "../../domain/measure-ledger/measure-ledger.root.js";

// Ledgers as the files under the ledger directory keep them: JSON with two
// spaces and a trailing newline, a scalar objective's told apart by `kind` —
// and, read only, the family's first layout.

// The family's first ledger: one campaign, one detector, one flat list.
// Read as one sector — the implicit one, named for the scope — and
// rewritten in the new layout on the next `clear`.
const LedgerV1 = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  created: Schema.String,
  initial: Schema.Finite,
  fixed: Schema.Finite,
  lastProgress: Schema.String,
  regressions: Schema.Array(
    Schema.Struct({
      at: Schema.String,
      by: Schema.String,
      delta: Schema.Finite,
      reason: Schema.String,
      entries: Schema.Array(Schema.String),
    }),
  ),
  entries: Schema.Array(Schema.String),
});

const decode = Schema.decodeUnknownResult(Ledger, {
  errors: "all",
  onExcessProperty: "error",
  reportInput: true,
});

const decodeV1 = Schema.decodeUnknownResult(LedgerV1, {
  errors: "all",
  onExcessProperty: "error",
  reportInput: true,
});

export const isLegacyLedger = (raw: unknown): boolean =>
  typeof raw === "object" && raw !== null && (raw as { readonly version?: unknown }).version === 1;

// A malformed ledger is refused, unlike a malformed baseline, which reads as
// empty: an empty baseline reports every violation, the safe direction, while
// an empty ledger would report every hit as unrecorded growth and demand a
// concession for debt that was already counted.
export const decodeLedger = (raw: unknown): Result.Result<Ledger, string> => {
  if (isLegacyLedger(raw)) {
    const decoded = decodeV1(raw);

    if (Result.isFailure(decoded)) return Result.fail(String(decoded.failure.issue));
    const old = decoded.success;

    return Result.succeed({
      version: 2,
      campaign: old.id,
      objective: old.id,
      created: old.created,
      sectors: {
        [IMPLICIT_SECTOR]: {
          entered: old.created,
          initial: old.initial,
          cleared: old.fixed,
          closed: 0,
          lastCleared: old.lastProgress,
          holdouts: old.entries,
        },
      },
      concessions: old.regressions.map((one) => ({
        sector: IMPLICIT_SECTOR,
        at: one.at,
        by: one.by,
        delta: one.delta,
        reason: one.reason,
        holdouts: one.entries,
      })),
    });
  }

  const decoded = decode(raw);

  return Result.isFailure(decoded)
    ? Result.fail(String(decoded.failure.issue))
    : Result.succeed(decoded.success);
};

export const serializeLedger = (ledger: Ledger): string => `${JSON.stringify(ledger, null, 2)}\n`;

const decodeMeasure = Schema.decodeUnknownResult(MeasureLedger, {
  errors: "all",
  onExcessProperty: "error",
  reportInput: true,
});

export const isMeasureLedger = (raw: unknown): boolean =>
  typeof raw === "object" &&
  raw !== null &&
  (raw as { readonly kind?: unknown }).kind === "measure";

export const decodeMeasureLedger = (raw: unknown): Result.Result<MeasureLedger, string> => {
  const decoded = decodeMeasure(raw);

  return Result.isFailure(decoded)
    ? Result.fail(String(decoded.failure.issue))
    : Result.succeed(decoded.success);
};

export const serializeMeasureLedger = (ledger: MeasureLedger): string =>
  `${JSON.stringify(ledger, null, 2)}\n`;

// The text of a stored file as JSON, or why it is not.
export const parseJson = (text: string): Result.Result<unknown, string> => {
  try {
    return Result.succeed(JSON.parse(text) as unknown);
  } catch (cause) {
    return Result.fail(String(cause));
  }
};

// ---------------------------------------------------------------------------
// Where the files are, so both hosts agree.

export const ledgerPathOf = (dir: string, campaign: string, objective: string): string =>
  `${dir}/${campaign}/${objective}.json`;

// The family's first layout: one file per campaign.
export const legacyLedgerPathOf = (dir: string, campaign: string): string =>
  `${dir}/${campaign}.json`;
