import * as Result from "effect/Result";

import type { LedgerId } from "../../domain/ledger/ledger.id.js";
import type { Ledger } from "../../domain/ledger/ledger.root.js";
import type { MeasureLedger } from "../../domain/measure-ledger/measure-ledger.root.js";
import type { ObjectiveLedgersRepository } from "../../domain/ports/repositories/objective-ledgers.repository.js";

export type ObjectiveLedgersRepositoryFake = ObjectiveLedgersRepository & {
  // What the repository holds now, keyed `<campaign>/<objective>`, or
  // `<campaign>` for a first-layout ledger.
  readonly stored: ReadonlyMap<string, Ledger | MeasureLedger>;
};

const keyOf = ({ campaign, objective }: LedgerId): string =>
  objective === null ? campaign : `${campaign}/${objective}`;

// In memory: a test states the ledgers there are, and reads back what was
// saved. A ledger is stored under the objective it names; a ledger in the
// family's first layout, which names its campaign as its objective, is
// seeded under `firstLayout` and found by `{ campaign, objective: null }`.
export const makeObjectiveLedgersRepositoryFake = (
  seed: ReadonlyArray<Ledger | MeasureLedger> = [],
  firstLayout: ReadonlyArray<Ledger> = [],
): ObjectiveLedgersRepositoryFake => {
  const stored = new Map<string, Ledger | MeasureLedger>([
    ...seed.map((one) => [keyOf(one), one] as const),
    ...firstLayout.map((one) => [keyOf({ campaign: one.campaign, objective: null }), one] as const),
  ]);

  return {
    stored,
    findOne: (id) => Result.succeed(stored.get(keyOf(id)) ?? null),
    save: (ledger) => {
      stored.set(keyOf(ledger), ledger);
    },
    remove: (id) => {
      stored.delete(keyOf(id));
    },
  };
};
