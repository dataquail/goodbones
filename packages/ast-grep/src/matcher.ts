import { Lang, parse, type SgNode } from "@ast-grep/napi";
import type { Position, SyntaxMatch, SyntaxMatcher, SyntaxTree } from "@goodbones/core";

// The core's `SyntaxMatcher` port over ast-grep. A campaign's `syntax` term is
// an ast-grep rule object, passed through as the `rule` of a `NapiConfig`;
// each node it matches becomes a `SyntaxMatch` with its text, what every
// metavariable captured, its range, and the nearest enclosing named
// declaration as its anchor. Nothing here knows about imports: narrowing a
// capture by what it is bound to is the core's, against the file's facts.
//
// The `kind` names a rule may use are tree-sitter's for the grammar ast-grep
// parses the file with (`class_declaration`, `call_expression`), and so is
// the anchor's notion of a declaration below. A matcher over another tree
// would ship its own mapping.

export type AstGrepOptions = {
  // File extension (with the dot) to ast-grep language id.
  readonly languages: Readonly<Record<string, Lang>>;
};

export const TYPESCRIPT_LANGUAGES: Readonly<Record<string, Lang>> = {
  ".ts": Lang.TypeScript,
  ".mts": Lang.TypeScript,
  ".cts": Lang.TypeScript,
  ".tsx": Lang.Tsx,
  ".js": Lang.JavaScript,
  ".mjs": Lang.JavaScript,
  ".cjs": Lang.JavaScript,
  ".jsx": Lang.JavaScript,
};

// The tree-sitter kinds that declare a name, and where the name sits. A
// class, function, method, variable declarator, type alias, interface, enum
// or module carries it in its `name` field.
const DECLARATION_KINDS: ReadonlySet<string> = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "method_signature",
  "variable_declarator",
  "type_alias_declaration",
  "interface_declaration",
  "enum_declaration",
  "internal_module",
  "module",
]);

// `kind()` is typed as a union over the grammar's static map; what it holds
// at runtime is the kind's name.
const kindOf = (node: SgNode): string => String(node.kind());

const nameOf = (node: SgNode): string | null => {
  try {
    const name = (node as SgNode & { field: (name: string) => SgNode | null }).field("name");
    return name === null ? null : name.text();
  } catch {
    return null;
  }
};

// The match itself when it is a named declaration, else the nearest ancestor
// that is one; `null` at the top level of the file.
const anchorOf = (node: SgNode): string | null => {
  if (DECLARATION_KINDS.has(kindOf(node))) {
    const own = nameOf(node);
    if (own !== null) return own;
  }
  for (const ancestor of node.ancestors()) {
    if (!DECLARATION_KINDS.has(kindOf(ancestor))) continue;
    const name = nameOf(ancestor);
    if (name !== null) return name;
  }
  return null;
};

// A metavariable of the rule: `$NAME` in a pattern, or a key of `constraints`.
// ast-grep reports captures by name on request rather than as a map, so the
// names are read off the rule's text and asked for one by one.
const METAVARIABLE = /\$([A-Z_][A-Z0-9_]*)/g;

const metavariablesOf = (rule: unknown): ReadonlyArray<string> => {
  const found = new Set<string>();
  for (const match of JSON.stringify(rule).matchAll(METAVARIABLE)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found];
};

const capturesOf = (node: SgNode, names: ReadonlyArray<string>): ReadonlyMap<string, string> => {
  const captures = new Map<string, string>();
  for (const name of names) {
    const single = node.getMatch(name);
    if (single !== null) {
      captures.set(name, single.text());
      continue;
    }
    const several = node.getMultipleMatches(name);
    if (several.length > 0) captures.set(name, several.map((one) => one.text()).join(""));
  }
  return captures;
};

const matchOf = (node: SgNode, names: ReadonlyArray<string>): SyntaxMatch => {
  const range = node.range();
  return {
    text: node.text(),
    captures: capturesOf(node, names),
    range: {
      start: { line: range.start.line, column: range.start.column },
      end: { line: range.end.line, column: range.end.column },
    },
    anchor: anchorOf(node),
  };
};

// Every named declaration in the tree, innermost last, for anchoring a
// position. Found once per tree; a kind the grammar does not have (a type
// alias in JavaScript) is skipped.
type Declared = {
  readonly name: string;
  readonly start: Position;
  readonly end: Position;
};

const declarationsOf = (root: SgNode): ReadonlyArray<Declared> => {
  const found: Array<Declared> = [];
  for (const kind of DECLARATION_KINDS) {
    let nodes: ReadonlyArray<SgNode>;
    try {
      nodes = root.findAll({ rule: { kind } });
    } catch {
      continue;
    }
    for (const node of nodes) {
      const name = nameOf(node);
      if (name === null) continue;
      const range = node.range();
      found.push({
        name,
        start: { line: range.start.line, column: range.start.column },
        end: { line: range.end.line, column: range.end.column },
      });
    }
  }
  return found;
};

const before = (left: Position, right: Position): boolean =>
  left.line < right.line || (left.line === right.line && left.column <= right.column);

const contains = (one: Declared, at: Position): boolean =>
  before(one.start, at) && before(at, one.end);

// The innermost declaration containing the position: of those that do, the
// one that starts last.
const anchorAtOf = (declared: ReadonlyArray<Declared>, at: Position): string | null => {
  let innermost: Declared | null = null;
  for (const one of declared) {
    if (!contains(one, at)) continue;
    if (innermost === null || before(innermost.start, one.start)) innermost = one;
  }
  return innermost === null ? null : innermost.name;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const extensionOf = (file: string): string => {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot);
};

export const astGrepMatcher = (
  options: AstGrepOptions = { languages: TYPESCRIPT_LANGUAGES },
): SyntaxMatcher => ({
  parse: (file, text): SyntaxTree | null => {
    const language = options.languages[extensionOf(file)];
    if (language === undefined) return null;
    const root = parse(language, text).root();
    let declared: ReadonlyArray<Declared> | null = null;
    return {
      anchorAt: (position) => {
        declared ??= declarationsOf(root);
        return anchorAtOf(declared, position);
      },
      findAll: (rule) => {
        if (!isRecord(rule)) {
          throw new Error(`a syntax rule is an object of ast-grep rule keys, not ${typeof rule}`);
        }
        // The engine refuses a rule it cannot read with its own sentence; it
        // is thrown as-is, since the probe check is what turns it into a
        // load failure that names the campaign.
        const names = metavariablesOf(rule);
        return root.findAll({ rule }).map((node) => matchOf(node, names));
      },
    };
  },
});
