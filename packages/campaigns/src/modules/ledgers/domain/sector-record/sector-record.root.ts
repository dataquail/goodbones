import * as Schema from "effect/Schema";

// The per-sector record: what derivation cannot say about a sector — the
// furthest phase it has reached, the phases attested for it, and the notes
// left for the next person or agent to touch it.

const Attestation = Schema.Struct({
  phase: Schema.String,
  reason: Schema.String,
  evidence: Schema.optionalKey(Schema.String),
  at: Schema.String,
  by: Schema.String,
  // Set when a concession sent the sector back below the phase: what was
  // attested no longer holds, and the sector stops there again until it is
  // attested anew. Kept, not deleted, so the record says what happened.
  revoked: Schema.optionalKey(
    Schema.Struct({ at: Schema.String, by: Schema.String, reason: Schema.String }),
  ),
});

const Note = Schema.Struct({
  at: Schema.String,
  by: Schema.String,
  // The phase the sector stood at when the note was left; a note under an
  // earlier phase leaves the nudge and stays in the file.
  phase: Schema.NullOr(Schema.String),
  text: Schema.String,
});

export const SectorRecord = Schema.Struct({
  version: Schema.Literal(1),
  campaign: Schema.String,
  sector: Schema.String,
  // The furthest phase ever derived for the sector, by id; `null` before
  // the first `clear` placed it.
  reached: Schema.NullOr(Schema.String),
  // When `reached` last advanced.
  since: Schema.String,
  attested: Schema.Array(Attestation),
  notes: Schema.Array(Note),
});

export type SectorRecord = typeof SectorRecord.Type;

export type Attestation = typeof Attestation.Type;

export type Note = typeof Note.Type;

export const EMPTY_SECTOR_RECORD = (
  campaign: string,
  sector: string,
  now: number,
): SectorRecord => ({
  version: 1,
  campaign,
  sector,
  reached: null,
  since: new Date(now).toISOString(),
  attested: [],
  notes: [],
});
