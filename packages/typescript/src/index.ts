import type { Language } from "@goodbones/core";

import { makeFactExtractorLive } from "./extractor.js";
import { makeModuleResolverLive, TYPESCRIPT } from "./resolver.js";

export { factsOfText, makeFactExtractorLive } from "./extractor.js";
export { npmPackageOf } from "./npm-package.js";
export { decodeTypescriptScopeOptions, type TypescriptScopeOptions } from "./options.js";
export { makeModuleResolverLive, TYPESCRIPT } from "./resolver.js";

// TypeScript, as one language pack: the parser-backed extractor and the
// `unrs-resolver`-backed resolver, behind the core's `Language` port. A host
// constructs this once, at its composition root, and hands it to `loadPolicy`;
// a second language is a second package shaped like this one.
export const typescriptLanguage = (): Language => ({
  id: TYPESCRIPT,
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  // A declaration file states types, not code; no linter visits one and no
  // policy is written about one.
  ignoredFiles: [/\.d\.[cm]?ts$/],
  // A folder holding a `package.json` is a package, and its source is under
  // `src` when it has one — the convention `infer` counts its depth from.
  packageMarkers: ["package.json"],
  sourceRoots: ["src"],
  extractor: makeFactExtractorLive(),
  fixes: ["subpath-namespace-import"],
  makeResolver: (repoRoot, scope) => makeModuleResolverLive(repoRoot, { scopes: [scope] }),
});
