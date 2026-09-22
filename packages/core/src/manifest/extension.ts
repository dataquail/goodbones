import type * as Result from "effect/Result";

import type { ManifestPath } from "../domain/manifest-location.js";

// A family the core does not own.
//
// The five per-file families, the graph and the limits are the core's: it
// declares their vocabulary, decodes it and evaluates it. A family that is
// not — `campaigns`, which @goodbones/campaigns owns — states which top-level
// manifest keys it claims, and decodes them itself. The core splits those
// keys off the expanded manifest before decoding what is left, so the core's
// codec never learns a word of the family's vocabulary and a key no
// extension claims is still the excess property it always was.
//
// This is the decode half. The load half — compiling, probing, and whatever
// state the family reads off disk — is `PolicyExtension` in `load/`, which
// needs the ports and so cannot live here.

export type ManifestExtension<Spec = unknown> = {
  // Names the family in errors, and keys it in `LoadedPolicy.extensions`.
  readonly id: string;
  // The top-level keys of the manifest this family owns.
  readonly manifestKeys: ReadonlyArray<string>;
  // The slice, as the expansion passes left it: the claimed keys that were
  // present, with `defs`/`use` and `include` already resolved.
  //
  // `describe` renders one issue the way the core's own decoder does — the
  // position in the file, the path, and the `use` it came through — so a
  // decode error from a family the core does not own reads exactly like one
  // from a tree node. Failure is a list of rendered lines, because a manifest
  // is edited by hand and the reader fixing one wants the other three.
  //
  // Declared as a method rather than a function property on purpose: the
  // loader holds extensions as `PolicyExtension<unknown, unknown>`, having
  // erased what each one decodes, and method signatures are what let a
  // concretely-typed extension be one of those.
  decode(
    slice: Readonly<Record<string, unknown>>,
    describe: (path: ManifestPath, detail: string) => string,
  ): Result.Result<Spec, ReadonlyArray<string>>;
};
