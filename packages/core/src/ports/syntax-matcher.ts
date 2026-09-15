// A campaign's `syntax` term asks a question the facts cannot answer: does
// this file contain an expression of this shape? A syntax matcher parses one
// file and finds every node matching a rule, returning the matched text, what
// each metavariable captured, where it sits, and the named declaration it
// sits in. The rule object is the engine's own — ast-grep's, for the one
// matcher that exists — and is carried opaquely; the matcher validates it.
//
// The matcher knows nothing about imports. Narrowing a capture by what its
// identifier is bound to is done in the core, against the file's facts and
// the resolver, so a second engine has only this port to implement.

export type Position = {
  // Zero-based line and column.
  readonly line: number;
  readonly column: number;
};

export type SyntaxMatch = {
  readonly text: string;
  // Each metavariable of the rule to the text it captured.
  readonly captures: ReadonlyMap<string, string>;
  readonly range: { readonly start: Position; readonly end: Position };
  // The name of the nearest enclosing named declaration — the match itself
  // when it is one — or `null` for a match at the top level of the file.
  readonly anchor: string | null;
};

export type SyntaxTree = {
  // Every node the rule matches, in source order. A rule the engine cannot
  // read throws, with the engine's own sentence.
  readonly findAll: (rule: unknown) => ReadonlyArray<SyntaxMatch>;
};

export type SyntaxMatcher = {
  // Parses one file's text. `null` when the matcher has no grammar for the
  // file's extension, which a campaign treats as a file with no matches.
  readonly parse: (file: string, text: string) => SyntaxTree | null;
};
