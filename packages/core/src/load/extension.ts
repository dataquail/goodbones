import type * as Result from "effect/Result";

import type { ResolveScope } from "../domain/architecture-config.js";
import type { ConfigInvalid, PatternInvalid } from "../domain/architecture-error.js";
import type { ManifestExtension } from "../manifest/extension.js";
import type { Manifest } from "../manifest/manifest.js";
import type { FactExtractor } from "../ports/fact-extractor.js";
import type { FileSystem } from "../ports/file-system.js";
import type { Language } from "../ports/language.js";
import type { SyntaxMatcher } from "../ports/syntax-matcher.js";

// The load half of a family the core does not own: what `loadPolicy` hands it,
// and what it hands back.
//
// A host composes the extensions it wants — `loadPolicy({ …, extensions: [
// campaignsExtension({ functions, reports }) ] })` — and reads its family's
// state back off `LoadedPolicy.extensions` through whatever typed accessor
// that package exports. The core carries the value and never looks inside it.
//
// An extension is given the same things the core's own families are given at
// load: the routing extractor and syntax matcher, the file system port, the
// language packs, and which scope covers a given file. It is not given the
// resolver, which is built after every rule has been probed — a family that
// needs one resolves at evaluation, off `LoadedPolicy`.

export type ExtensionRoute = {
  readonly language: Language;
  readonly scope: ResolveScope;
};

export type ExtensionContext<Spec = unknown> = {
  // What this family's `decode` returned.
  readonly spec: Spec;
  readonly configPath: string;
  readonly repoRoot: string;
  // The manifest the core decoded — `resolve`, `aliases`, `tree`, the
  // families the core owns. The family's own keys are in `spec`.
  readonly config: Manifest;
  readonly languages: ReadonlyArray<Language>;
  readonly fileSystem: FileSystem;
  // Routes each file to the extractor of the language whose scope covers it:
  // the same one the core parsed its own probes with.
  readonly extractor: FactExtractor;
  // Routes each file to the syntax matcher of its scope's language; `parse`
  // answers `null` for a language carrying none.
  readonly syntax: SyntaxMatcher;
  readonly routeFor: (file: string) => ExtensionRoute | undefined;
  readonly now: number;
};

export type LoadedExtension<Value = unknown> = {
  // Carried on `LoadedPolicy.extensions`, keyed by the extension's id.
  readonly value: Value;
  // Rules of this family that do not report their own probe. Merged into the
  // one refusal the loader raises for every family at once, so a vacuous
  // campaign and a vacuous import rule are reported in the same sentence.
  readonly vacuous?: ReadonlyArray<string> | undefined;
};

export type PolicyExtension<Spec = unknown, Value = unknown> = ManifestExtension<Spec> & {
  // A method, like `decode`, so the loader can hold every extension at one
  // erased type after their specs have been decoded.
  load(
    context: ExtensionContext<Spec>,
  ): Result.Result<LoadedExtension<Value>, ConfigInvalid | PatternInvalid>;
};
