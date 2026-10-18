import type { SourceFacts } from "../domain/facts.js";
import type { FactExtractor } from "../ports/fact-extractor.js";

const NOTHING: SourceFacts = {
  specifiers: [],
  bindings: new Map(),
  memberSites: [],
  exportSites: [],
};

// Keyed by the source text itself: a core test states what a snippet reads as
// and never the parse, which has its own tests against the real extractor. A
// snippet not staged reads as nothing — the shape of a form the extractor is
// blind to, which is the case a source probe exists to catch.
export const makeFactExtractorFake = (
  facts: Readonly<Record<string, Partial<SourceFacts>>>,
): FactExtractor => ({
  factsOf: (file, text) => {
    const found = facts[text];

    if (found === undefined) return NOTHING;

    return {
      ...NOTHING,
      ...found,
      memberSites: (found.memberSites ?? []).map((site) => ({ ...site, file })),
      exportSites: (found.exportSites ?? []).map((site) => ({ ...site, file })),
    };
  },
});
