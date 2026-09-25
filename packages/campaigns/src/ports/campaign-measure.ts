import type { CampaignPredicateInput } from "./campaign-predicate.js";

// The floor of a scalar objective's measure: a function the repository
// writes, named from the manifest as `module#export` exactly as a `fn`
// detector term is, and loaded the same way. It is given what the evaluator
// has about one file and answers the number that file contributes — a
// count, a size, a weight — which the host sums over each sector. Anything
// but a finite number of zero or more is a measure that did not answer, and
// `check` refuses it. Exported as a public type so a referenced module
// typechecks on its own.
export type CampaignMeasure = (input: CampaignPredicateInput) => number;
