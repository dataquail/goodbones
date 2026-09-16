import type { SyntaxMatch, SyntaxMatcher } from "../ports/syntax-matcher.js";

// One match as a test states it: the text, its captures as a plain object,
// the anchor, and optionally a line — the rest of the range is filled in.
// `rule` narrows the match to one rule (compared by its JSON), so a test
// about two `syntax` terms can answer each differently; omit it to answer
// every rule the same.
export type StagedMatch = {
  readonly text: string;
  readonly captures?: Readonly<Record<string, string>>;
  readonly anchor?: string | null;
  readonly line?: number;
  readonly rule?: unknown;
};

const ZERO = { line: 0, column: 0 };

// Keyed by the source text, as the extractor fake is: a core test states
// what a snippet's syntax yields and never the parse, which has its own
// tests in the matcher package. A text not staged parses to no matches; a
// file whose extension is not among `extensions` does not parse at all,
// which is the shape of a language with no matcher.
export const makeSyntaxMatcherFake = (
  staged: Readonly<Record<string, ReadonlyArray<StagedMatch>>>,
  extensions: ReadonlyArray<string> | null = null,
): SyntaxMatcher => ({
  parse: (file, text) => {
    if (extensions !== null && !extensions.some((extension) => file.endsWith(extension))) {
      return null;
    }
    const matches = staged[text] ?? [];
    return {
      // A staged match's line is what a position is anchored by.
      anchorAt: (position) => matches.find((one) => one.line === position.line)?.anchor ?? null,
      findAll: (rule) => {
        const asked = JSON.stringify(rule);
        return matches
          .filter((one) => one.rule === undefined || JSON.stringify(one.rule) === asked)
          .map((one): SyntaxMatch => ({
            text: one.text,
            captures: new Map(Object.entries(one.captures ?? {})),
            range: {
              start: one.line === undefined ? ZERO : { line: one.line, column: 0 },
              end: one.line === undefined ? ZERO : { line: one.line, column: one.text.length },
            },
            anchor: one.anchor ?? null,
          }));
      },
    };
  },
});
