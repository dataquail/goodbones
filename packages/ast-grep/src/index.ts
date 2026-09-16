// The ast-grep syntax matcher, as one package: a campaign's `syntax` term
// evaluated through `@ast-grep/napi`, behind the core's `SyntaxMatcher` port.
// A host composes it into a language pack (`typescriptLanguage({ syntax:
// astGrepMatcher() })`); the pack never names it, and the core never imports
// it. A second engine over another tree is a second package shaped like this.
export { astGrepMatcher, type AstGrepOptions, TYPESCRIPT_LANGUAGES } from "./matcher.js";
