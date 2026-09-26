// What the Campaign Browser can hold: the campaign itself, or one of its
// phases, objectives or sectors.
export type Pick =
  | { readonly kind: "campaign" }
  | { readonly kind: "phase"; readonly id: string }
  | { readonly kind: "objective"; readonly id: string }
  | { readonly kind: "sector"; readonly name: string };
