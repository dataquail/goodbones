import type { SentBack } from "../domain/services/concession.service.js";

export type ConcedeOutcome = {
  readonly objective: string;
  readonly conceded: ReadonlyArray<{ sector: string; entry: string }>;
  readonly left: ReadonlyArray<{ sector: string; entry: string }>;
  // The sectors the concession sent back a phase, with the attestations it
  // revoked on the way.
  readonly sentBack: ReadonlyArray<SentBack>;
};
