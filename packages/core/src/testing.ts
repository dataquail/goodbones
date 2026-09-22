// One fake per port, for tests that state facts and never read a file, run a
// parser or resolve a specifier. A language pack's tests and a host's tests
// both drive these; so do the core's own.
export { makeFactExtractorFake } from "./infrastructure/fact-extractor-fake.js";
export { makeFileSystemFake } from "./infrastructure/file-system-fake.js";
export { makeModuleResolverFake } from "./infrastructure/module-resolver-fake.js";
export { makeSyntaxMatcherFake, type StagedMatch } from "./infrastructure/syntax-matcher-fake.js";
