// A manifest line as coloured runs. Not a YAML parser: enough of the surface
// syntax to tell a tree key from a rule key, a glob from prose, and a comment
// from both, carried line to line only through the one state YAML makes a
// line depend on — being inside a block scalar (`message: >-`).

export type TokenKind =
  | "plain"
  | "comment"
  | "path-key"
  | "key"
  | "punct"
  | "string"
  | "text"
  | "indicator"
  | "literal"
  | "ref";

export type Token = { readonly kind: TokenKind; readonly text: string };

// Inside a block scalar: lines indented deeper than the key that opened it.
export type LexState = { readonly blockIndent: number | null };

export const START: LexState = { blockIndent: null };

// Keys whose value names a fragment or a file rather than a pattern.
const REFERENCE_KEYS = new Set(["use", "include"]);

const LITERAL = /^(?:true|false|null|~|-?\d+(?:\.\d+)?)$/;
const QUOTED = /^(?:"(?:[^"\\]|\\.)*"?|'(?:[^']|'')*'?)/;
const BLOCK_INDICATOR = /^[|>][-+]?\d*(?=\s*(?:#.*)?$)/;

// A tree key names a place: a folder, a glob, a capture or an alias.
const isPathKey = (key: string): boolean => {
  const bare = key.replace(/^["']|["']$/g, "");
  return /[/*{}@~|]/.test(bare) || /\.[a-z]+$/i.test(bare);
};

export const tokenize = (
  line: string,
  state: LexState,
): { readonly tokens: ReadonlyArray<Token>; readonly state: LexState } => {
  const indent = line.length - line.trimStart().length;
  if (state.blockIndent !== null && (line.trim() === "" || indent > state.blockIndent)) {
    return { tokens: [{ kind: "text", text: line }], state };
  }

  const tokens: Array<Token> = [];
  const push = (kind: TokenKind, text: string): void => {
    if (text === "") return;
    const last = tokens.at(-1);
    if (last?.kind === kind) tokens[tokens.length - 1] = { kind, text: last.text + text };
    else tokens.push({ kind, text });
  };

  let rest = line;
  let next: LexState = START;
  let lastKey: string | null = null;
  let keyColumn = indent;
  let depth = 0; // inside `{…}` or `[…]`
  let atValueStart = false;

  const take = (count: number): string => {
    const text = rest.slice(0, count);
    rest = rest.slice(count);
    return text;
  };

  // A key at the cursor: quoted or bare, then `:` and a space or the end.
  const keyAhead = (): string | null => {
    const quoted = QUOTED.exec(rest);
    const candidate =
      quoted !== null
        ? quoted[0]
        : (/^[^\s:#,{}[\]"'][^:#,{}[\]]*?(?=:(?:\s|$))/.exec(rest)?.[0] ?? null);
    if (candidate === null) return null;
    return /^:(?:\s|$)/.test(rest.slice(candidate.length)) ? candidate : null;
  };

  while (rest.length > 0) {
    const space = /^\s+/.exec(rest);
    if (space !== null) {
      push("plain", take(space[0].length));
      continue;
    }
    if (rest.startsWith("#")) {
      push("comment", take(rest.length));
      break;
    }
    if (depth === 0 && /^-(?:\s|$)/.test(rest)) {
      push("punct", take(1));
      keyColumn = line.length - rest.length + 1;
      continue;
    }
    const key = keyAhead();
    if (key !== null) {
      if (depth === 0) keyColumn = line.length - rest.length;
      push(isPathKey(key) ? "path-key" : "key", take(key.length));
      push("punct", take(1));
      lastKey = key.replace(/^["']|["']$/g, "");
      atValueStart = true;
      continue;
    }
    if (atValueStart && depth === 0) {
      const indicator = BLOCK_INDICATOR.exec(rest);
      if (indicator !== null) {
        push("indicator", take(indicator[0].length));
        next = { blockIndent: keyColumn };
        continue;
      }
    }
    atValueStart = false;
    if (/^[{[]/.test(rest)) {
      depth += 1;
      push("punct", take(1));
      continue;
    }
    if (/^[}\],]/.test(rest)) {
      depth = Math.max(0, depth - 1 + (rest.startsWith(",") ? 1 : 0));
      push("punct", take(1));
      continue;
    }
    const quoted = QUOTED.exec(rest);
    if (quoted !== null) {
      push(
        lastKey !== null && REFERENCE_KEYS.has(lastKey) ? "ref" : "string",
        take(quoted[0].length),
      );
      continue;
    }
    // A bare scalar runs to a comment, or in a flow collection to its delimiter.
    const bare = (depth > 0 ? /^[^,{}[\]#]+?(?=\s*(?:[,}\]]|\s#|$))/ : /^.+?(?=\s+#|$)/).exec(rest);
    const text = bare?.[0] ?? take(1);
    if (bare !== null) take(text.length);
    push(
      lastKey !== null && REFERENCE_KEYS.has(lastKey)
        ? "ref"
        : LITERAL.test(text.trim())
          ? "literal"
          : "plain",
      text,
    );
  }
  return { tokens, state: next };
};

// Every line of a file, lexed in order.
export const tokenizeLines = (
  lines: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<Token>> => {
  let state = START;
  return lines.map((line) => {
    const result = tokenize(line, state);
    state = result.state;
    return result.tokens;
  });
};
