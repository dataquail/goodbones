import type { Language, SyntaxMatcher } from "@goodbones/core";

import { makeFactExtractorLive } from "./extractor.js";
import { makeModuleResolverLive, TYPESCRIPT } from "./resolver.js";

export {
  type EdgeForm,
  factsOfText,
  makeFactExtractorLive,
  type ProgramBody,
  type ReadBinding,
  type ReadEdge,
  type ReadExportSite,
  type ReadFacts,
  type ReadMemberSite,
  readProgram,
  sourceFactsOf,
  type SyntaxNode,
} from "./extractor.js";
export { npmPackageOf } from "./npm-package.js";
export { decodeTypescriptScopeOptions, type TypescriptScopeOptions } from "./options.js";
export { makeModuleResolverLive, TYPESCRIPT } from "./resolver.js";

export type TypescriptLanguageOptions = {
  // A syntax matcher for the campaigns family's `syntax` term. The pack
  // never names one — `@goodbones/ast-grep` is what a host composes it with.
  readonly syntax?: SyntaxMatcher | undefined;
};

// TypeScript, as one language pack: the parser-backed extractor and the
// `unrs-resolver`-backed resolver, behind the core's `Language` port. A host
// constructs this once, at its composition root, and hands it to `loadPolicy`;
// a second language is a second package shaped like this one.
export const typescriptLanguage = (options: TypescriptLanguageOptions = {}): Language => ({
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
  ...(options.syntax === undefined ? {} : { syntax: options.syntax }),
  makeResolver: (repoRoot, scope) => makeModuleResolverLive(repoRoot, { scopes: [scope] }),
});
