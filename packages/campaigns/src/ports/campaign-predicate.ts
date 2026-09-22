import type { SourceFacts, SyntaxTree } from "@goodbones/core";

// The floor of a campaign's detector: a predicate function the repository
// writes, named from the manifest as `module#export` and handed to the
// policy by the host. It is given what the evaluator has about one file and
// answers either a verdict about the file or the subjects it found in it —
// a declaration name, or any key a `match` campaign should ledger — each
// optionally with where it sits. Exported as a public type so a referenced
// module typechecks on its own.

export type Range = {
  // Zero-based.
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
};

export type CampaignPredicateInput = {
  readonly file: string;
  readonly text: string;
  readonly facts: SourceFacts;
  // The file parsed by the scope's syntax matcher, or `null` without one.
  readonly syntax: SyntaxTree | null;
};

export type CampaignSubject = { readonly subject: string; readonly range?: Range };

export type CampaignPredicate = (
  input: CampaignPredicateInput,
) => boolean | ReadonlyArray<CampaignSubject>;
