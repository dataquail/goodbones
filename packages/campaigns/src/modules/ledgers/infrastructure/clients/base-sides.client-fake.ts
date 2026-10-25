import type { BaseSide } from "../../domain/base-side/base-side.value-object.js";
import type { BaseSidesClient } from "../../domain/ports/clients/base-sides.client.js";

// The cache in memory, with what was written kept for a test to read.
export type BaseSidesClientFake = BaseSidesClient & {
  readonly written: ReadonlyMap<string, BaseSide>;
};

export const makeBaseSidesClientFake = (
  sides: ReadonlyMap<string, BaseSide> = new Map(),
): BaseSidesClientFake => {
  const written = new Map(sides);

  return {
    read: (sha) => written.get(sha) ?? null,
    write: (sha, side) => {
      written.set(sha, side);
    },
    written,
  };
};
