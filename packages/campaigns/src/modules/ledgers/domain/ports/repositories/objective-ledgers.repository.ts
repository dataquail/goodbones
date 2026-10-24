import type * as Result from "effect/Result";

import type { LedgerUnreadable } from "../../ledger/ledger.errors.js";
import type { LedgerId } from "../../ledger/ledger.id.js";
import type { Ledger } from "../../ledger/ledger.root.js";
import type { MeasureLedger } from "../../measure-ledger/measure-ledger.root.js";

// Every objective's ledger: a holdout ledger or a scalar objective's, which
// share a path and are told apart by what the file says. An absent ledger is
// `null` — an objective `clear` has not been run for — and a malformed one is
// refused. A ledger is saved where its campaign and objective say it lives.
export type ObjectiveLedgersRepository = {
  readonly findOne: (
    id: LedgerId,
  ) => Result.Result<Ledger | MeasureLedger | null, LedgerUnreadable>;
  readonly save: (ledger: Ledger | MeasureLedger) => void;
  readonly remove: (id: LedgerId) => void;
};
