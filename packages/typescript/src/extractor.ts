import type {
  Binding,
  DeclarationKind,
  ExportSite,
  FactExtractor,
  MemberSite,
  SourceFacts,
} from "@goodbones/core";
import {
  type BindingIdentifier,
  type BindingPattern,
  type BindingRestElement,
  type CallExpression,
  type ClassElement,
  type Declaration,
  type Directive,
  type ExportDefaultDeclaration,
  type ExportNamedDeclaration,
  type Expression,
  type ImportDeclarationSpecifier,
  type ModuleExportName,
  type Node,
  type ParserOptions,
  parseSync,
  type Program,
  type PropertyKey,
  rawTransferSupported,
  type Statement,
  type TSModuleDeclaration,
  type TSSignature,
  type TSType,
  type TSTypeLiteral,
  Visitor,
} from "oxc-parser";

// The facts, read out of one ESTree. oxc-parser emits this tree for the CLI
// and oxlint hands the same tree to a plugin, so one reader serves both hosts:
// `readProgram` walks a `Program` and returns every fact with the node it came
// from, the plugin reports at those nodes, and `factsOfText` parses then strips
// them. The parity suite in `@goodbones/oxlint` pins that the two parsers, at
// their paired versions, produce the tree this reader expects.

// A fact with the syntax node it was read from — what a host that reports at
// a position needs, and what the core, which is position-free by design, never
// sees. `SourceFacts` is this with the nodes stripped.
export type SyntaxNode = Node;

// The syntactic form an edge was written in. Only an `import` declaration can
// be rewritten by an `exports` fix; the rest are reported and left as written.
export type EdgeForm = "import" | "export" | "import-equals" | "import-expression" | "require";

// One binding, with the node it was declared at and the local name it was
// bound to — the name a rewrite of the declaration has to preserve.
export type ReadBinding = Binding & { readonly node: SyntaxNode; readonly local: string };

// One place in the source that names a module. The same specifier written
// twice is two edges here and one in `SourceFacts.specifiers`.
export type ReadEdge = {
  readonly specifier: string;
  readonly form: EdgeForm;
  readonly node: SyntaxNode;
  readonly bindings: ReadonlyArray<ReadBinding>;
};

export type ReadMemberSite = MemberSite & { readonly node: SyntaxNode };
export type ReadExportSite = ExportSite & { readonly node: SyntaxNode };

export type ReadFacts = {
  readonly edges: ReadonlyArray<ReadEdge>;
  readonly memberSites: ReadonlyArray<ReadMemberSite>;
  readonly exportSites: ReadonlyArray<ReadExportSite>;
};

// The whole module, as one binding. `export * from "m"`, `export * as ns from
// "m"`, `import x = require("m")`, `import("m")` and `require("m")` all carry
// every export of `m` at once, exactly as `import * as ns` does — and are the
// same way around a rule about a name. A side-effect import carries nothing.
const wholeModule = (node: SyntaxNode, local: string): ReadonlyArray<ReadBinding> => [
  { symbol: "*", kind: "namespace", node, local },
];

// The name written at a key or a module export name: an identifier, or a
// string literal (`import { "a-b" as ab }`, `"c-d": number`). A numeric key,
// a private `#name` and a computed expression are not names a rule can speak
// about.
const nameOf = (node: PropertyKey | ModuleExportName | BindingIdentifier | null): string | null => {
  if (node === null) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
};

const bindingOf = (specifier: ImportDeclarationSpecifier): ReadBinding | null => {
  const local = specifier.local.name;
  switch (specifier.type) {
    case "ImportSpecifier": {
      const symbol = nameOf(specifier.imported);
      return symbol === null ? null : { symbol, kind: "named", node: specifier, local };
    }
    case "ImportDefaultSpecifier":
      return { symbol: "default", kind: "default", node: specifier, local };
    case "ImportNamespaceSpecifier":
      return { symbol: "*", kind: "namespace", node: specifier, local };
  }
};

// `export { a as b } from "m"` — `local` is the name in the source module, so
// it is the one the policy is about.
const reexportedBindings = (node: ExportNamedDeclaration): ReadonlyArray<ReadBinding> => {
  const found: Array<ReadBinding> = [];
  for (const specifier of node.specifiers) {
    const symbol = nameOf(specifier.local);
    if (symbol !== null) found.push({ symbol, kind: "named", node: specifier, local: symbol });
  }
  return found;
};

// The type literals written in a type, through intersections and unions:
// `type Port = Base & ({ a(): void } | { b(): void })` declares `a` and `b`. A
// reference is not followed — `Base`'s members are declared where `Base` is,
// and are reported there under its own name. The parenthesised form is read
// too, for a tree parsed with `preserveParens`; oxlint's and `factsOfText`'s
// carry none.
const literalsOf = (node: TSType): ReadonlyArray<TSTypeLiteral> => {
  switch (node.type) {
    case "TSTypeLiteral":
      return [node];
    case "TSIntersectionType":
    case "TSUnionType":
      return node.types.flatMap(literalsOf);
    case "TSParenthesizedType":
      return literalsOf(node.typeAnnotation);
    default:
      return [];
  }
};

// The key of a member shape that carries a name a vocabulary rule can speak
// about: a property or method signature in a type; a property, method,
// accessor or auto-accessor in a class. A computed key is no name, and neither
// is an index, call or construct signature, a static block, or a constructor.
const keyOf = (member: TSSignature | ClassElement): PropertyKey | null => {
  switch (member.type) {
    case "TSPropertySignature":
    case "TSMethodSignature":
    case "PropertyDefinition":
    case "TSAbstractPropertyDefinition":
    case "AccessorProperty":
    case "TSAbstractAccessorProperty":
      return member.computed ? null : member.key;
    case "MethodDefinition":
    case "TSAbstractMethodDefinition":
      return member.computed || member.kind === "constructor" ? null : member.key;
    default:
      return null;
  }
};

// The name a call is made by: `f()` and `x.f()` are both `f`. `x[f]()` and
// `x["f"]()` are not — a computed property is not a name a vocabulary rule can
// speak about — and neither is a private `x.#f()`.
const calleeNameOf = (callee: Expression): string | null => {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed) return nameOf(callee.property);
  return null;
};

const requireSpecifierOf = (node: CallExpression): string | null => {
  if (node.callee.type !== "Identifier" || node.callee.name !== "require") return null;
  const [first] = node.arguments;
  return first?.type === "Literal" && typeof first.value === "string" ? first.value : null;
};

// The identifiers a binding pattern introduces.
const patternNames = (pattern: BindingPattern | BindingRestElement): ReadonlyArray<string> => {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property) =>
        patternNames(property.type === "Property" ? property.value : property.argument),
      );
    case "ArrayPattern":
      return pattern.elements.flatMap((element) => (element === null ? [] : patternNames(element)));
    case "AssignmentPattern":
      return patternNames(pattern.left);
    case "RestElement":
      return patternNames(pattern.argument);
  }
};

// `namespace A.B {}` declares `A`; `declare module "m" {}` declares no name a
// module's surface can carry.
const moduleNameOf = (node: TSModuleDeclaration): string | null => {
  const id = node.id;
  if (id.type !== "TSQualifiedName") return nameOf(id);
  let left = id.left;
  while (left.type === "TSQualifiedName") left = left.left;
  return left.type === "Identifier" ? left.name : null;
};

// The names a declaration statement introduces, with what it declares them as.
// A destructuring pattern introduces names too, but not ones a surface rule
// judges by declaration kind; they read as `variable` like the rest.
const declaredNamesOf = (
  declaration: Directive | Statement,
): ReadonlyArray<readonly [string, DeclarationKind]> => {
  const named = (
    name: string | null,
    declares: DeclarationKind,
  ): ReadonlyArray<readonly [string, DeclarationKind]> => (name === null ? [] : [[name, declares]]);
  switch (declaration.type) {
    case "VariableDeclaration":
      return declaration.declarations.flatMap((one) =>
        patternNames(one.id).map((name) => [name, "variable"] as const),
      );
    case "FunctionDeclaration":
    case "TSDeclareFunction":
      return named(declaration.id?.name ?? null, "function");
    case "ClassDeclaration":
      return named(declaration.id?.name ?? null, "class");
    case "TSTypeAliasDeclaration":
      return named(declaration.id.name, "type");
    case "TSInterfaceDeclaration":
      return named(declaration.id.name, "interface");
    case "TSEnumDeclaration":
      return named(declaration.id.name, "enum");
    case "TSModuleDeclaration":
      return named(declaration.global ? declaration.id.name : moduleNameOf(declaration), "other");
    default:
      return [];
  }
};

// The declaration an `export default …` carries, when it is one — a function,
// class or interface, named or not — rather than an expression.
const defaultDeclaration = (node: ExportDefaultDeclaration): Declaration | null => {
  const declaration = node.declaration;
  switch (declaration.type) {
    case "FunctionDeclaration":
    case "TSDeclareFunction":
    case "ClassDeclaration":
    case "TSInterfaceDeclaration":
      return declaration;
    default:
      return null;
  }
};

// What `export default …` declares: a function, class or interface by its
// shape, named or not; an identifier by the declaration it names in this
// file; any other expression as one.
const defaultDeclares = (
  node: ExportDefaultDeclaration,
  locals: ReadonlyMap<string, DeclarationKind>,
): DeclarationKind => {
  const declaration = node.declaration;
  switch (declaration.type) {
    case "FunctionDeclaration":
    case "TSDeclareFunction":
      return "function";
    case "ClassDeclaration":
      return "class";
    case "TSInterfaceDeclaration":
      return "interface";
    case "Identifier":
      return locals.get(declaration.name) ?? "expression";
    default:
      return "expression";
  }
};

// A file's surface: what its top-level statements export, in source order,
// read off the program body rather than by visiting export nodes — an `export`
// inside a namespace body is that namespace's, not the module's, and reading
// the top level directly is what says so without a parent pointer. `export =`
// is a CommonJS surface, not a module's, and is stepped over.
const exportSitesOf = (
  file: string,
  body: ReadonlyArray<Directive | Statement>,
): ReadonlyArray<ReadExportSite> => {
  const locals = new Map<string, DeclarationKind>();
  for (const statement of body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement.type === "ExportDefaultDeclaration"
          ? defaultDeclaration(statement)
          : statement;
    if (declaration === null) continue;
    for (const [name, declares] of declaredNamesOf(declaration)) locals.set(name, declares);
  }

  const sites: Array<ReadExportSite> = [];
  const site = (
    node: SyntaxNode,
    name: string,
    kind: ExportSite["kind"],
    declares: DeclarationKind,
    reexport: boolean,
  ): void => {
    sites.push({ file, name, kind, declares, reexport, node });
  };

  for (const statement of body) {
    switch (statement.type) {
      case "ExportNamedDeclaration": {
        const declaration = statement.declaration;
        if (declaration !== null) {
          for (const [name, declares] of declaredNamesOf(declaration)) {
            site(declaration, name, "named", declares, false);
          }
          break;
        }
        const reexport = statement.source !== null;
        for (const specifier of statement.specifiers) {
          const name = nameOf(specifier.exported);
          if (name === null) continue;
          const local = nameOf(specifier.local) ?? name;
          const declares = reexport ? "other" : (locals.get(local) ?? "other");
          site(specifier, name, name === "default" ? "default" : "named", declares, reexport);
        }
        break;
      }
      case "ExportDefaultDeclaration":
        site(statement, "default", "default", defaultDeclares(statement, locals), false);
        break;
      case "ExportAllDeclaration":
        site(statement, nameOf(statement.exported) ?? "*", "namespace", "other", true);
        break;
      default:
        break;
    }
  }
  return sites;
};

// What the reader takes: the statements of one program. oxlint's `Program`
// and oxc-parser's differ in what else they carry, and the reader reads
// nothing else.
export type ProgramBody = Pick<Program, "body">;

// The read in progress: where the walk's handlers write. One `Visitor` is
// compiled once for the module — oxc-parser keeps every compiled visitor's
// handlers in a cache it never trims, so compiling one per call would retain
// the handlers and, through them, every tree ever read. `readProgram` is
// synchronous and no handler re-enters it, so one slot is enough.
type Reading = {
  readonly file: string;
  readonly edges: Array<ReadEdge>;
  readonly memberSites: Array<ReadMemberSite>;
};

const IDLE: Reading = { file: "", edges: [], memberSites: [] };
let reading: Reading = IDLE;

const edge = (
  node: SyntaxNode,
  specifier: string,
  form: EdgeForm,
  bindings: ReadonlyArray<ReadBinding>,
): void => {
  reading.edges.push({ specifier, form, node, bindings });
};

// The members written in a declaration, under that declaration's name and
// kind, each at its key.
const declared = (
  declaration: string,
  declares: DeclarationKind,
  members: ReadonlyArray<TSSignature | ClassElement>,
): void => {
  for (const member of members) {
    const key = keyOf(member);
    if (key === null) continue;
    const name = nameOf(key);
    if (name !== null) {
      reading.memberSites.push({
        file: reading.file,
        subject: "members",
        name,
        in: declaration,
        declares,
        node: key,
      });
    }
  }
};

// Every form that names a module is an edge, in source order. A computed
// `import(expr)` or `require(expr)` is not a fact a static policy can speak
// about.
const walker = new Visitor({
  ImportDeclaration(node) {
    // A side-effect import carries no bindings but is still an edge — the
    // `import "server-only"` form a regex cannot see.
    const bindings = node.specifiers.flatMap((specifier) => {
      const found = bindingOf(specifier);
      return found === null ? [] : [found];
    });
    edge(node, node.source.value, "import", bindings);
  },
  ExportNamedDeclaration(node) {
    if (node.source !== null) edge(node, node.source.value, "export", reexportedBindings(node));
  },
  ExportAllDeclaration(node) {
    edge(node, node.source.value, "export", wholeModule(node, nameOf(node.exported) ?? ""));
  },
  TSImportEqualsDeclaration(node) {
    const reference = node.moduleReference;
    if (reference.type === "TSExternalModuleReference") {
      edge(node, reference.expression.value, "import-equals", wholeModule(node, node.id.name));
    }
  },
  ImportExpression(node) {
    if (node.source.type === "Literal" && typeof node.source.value === "string") {
      edge(node, node.source.value, "import-expression", wholeModule(node, ""));
    }
  },
  CallExpression(node) {
    const required = requireSpecifierOf(node);
    if (required !== null) edge(node, required, "require", wholeModule(node, ""));

    const callee = calleeNameOf(node.callee);
    if (callee !== null) {
      reading.memberSites.push({ file: reading.file, subject: "calls", name: callee, node });
    }
  },
  TSTypeAliasDeclaration(node) {
    declared(
      node.id.name,
      "type",
      literalsOf(node.typeAnnotation).flatMap((literal) => literal.members),
    );
  },
  TSInterfaceDeclaration(node) {
    declared(node.id.name, "interface", node.body.body);
  },
  // A named class only: an anonymous default class has no name for `in`, and
  // a class expression is a value. `ClassDeclaration` is the visitor key, so a
  // class expression is never handed in.
  ClassDeclaration(node) {
    if (node.id !== null) declared(node.id.name, "class", node.body.body);
  },
});

// Reads every fact out of one program, with the node each came from. Pure over
// the tree: oxlint's plugin calls it on the tree oxlint parsed, and
// `factsOfText` on the one oxc-parser did.
export const readProgram = (file: string, program: ProgramBody): ReadFacts => {
  const read: Reading = { file, edges: [], memberSites: [] };
  reading = read;
  // The walk starts at a root of this shape and reads only its `body`.
  walker.visit({
    type: "Program",
    body: program.body,
    sourceType: "module",
    hashbang: null,
    start: 0,
    end: 0,
  });
  reading = IDLE;
  return {
    edges: read.edges,
    memberSites: read.memberSites,
    exportSites: exportSitesOf(file, program.body),
  };
};

const langOf = (file: string): "ts" | "tsx" => (file.endsWith(".tsx") ? "tsx" : "ts");

// Raw transfer hands the tree over as bytes and builds the nodes here, rather
// than serialising it to JSON in Rust and parsing that back — about three
// times the throughput of the JSON path on a source tree of ordinary files,
// and the difference between this parser and the compiler API being faster
// or slower. The buffer it reads from is reused across parses and returned
// before the tree is, so nothing here outlives a parse. The option is not in
// the parser's declared type yet; it is read all the same. Where the platform
// cannot do it (32-bit, big-endian, a Node before 22), the JSON path is what
// runs, at the same answer.
const RAW_TRANSFER: ParserOptions & { readonly experimentalRawTransfer: boolean } = {
  experimentalRawTransfer: rawTransferSupported(),
  preserveParens: false,
};

const stripNode = <T extends { readonly node: SyntaxNode }>(carrying: T): Omit<T, "node"> => {
  const { node: _node, ...fact } = carrying;
  return fact;
};

// The facts with the nodes stripped: one entry per specifier, in the order
// first written, carrying every binding pulled across it.
export const sourceFactsOf = (read: ReadFacts): SourceFacts => {
  const specifiers: Array<string> = [];
  const bindings = new Map<string, Array<Binding>>();
  for (const edge of read.edges) {
    let found = bindings.get(edge.specifier);
    if (found === undefined) {
      found = [];
      bindings.set(edge.specifier, found);
      specifiers.push(edge.specifier);
    }
    for (const { kind, symbol } of edge.bindings) found.push({ symbol, kind });
  }
  return {
    specifiers,
    bindings,
    memberSites: read.memberSites.map(stripNode),
    exportSites: read.exportSites.map(stripNode),
  };
};

// The parse alone, for a source that need not be on disk — the CLI reads
// every file through it, a source probe is checked through it at load, and the
// parity suite feeds both hosts the same snippet through it. Parentheses are
// not kept as nodes, which is the tree oxlint hands a plugin. A syntax error
// does not throw: oxc reports it and returns an empty program, so a file that
// does not parse contributes no facts — the same file no linter would visit.
export const factsOfText = (file: string, text: string): SourceFacts => {
  const { program } = parseSync(file, text, { ...RAW_TRANSFER, lang: langOf(file) });
  return sourceFactsOf(readProgram(file, program));
};

export const makeFactExtractorLive = (): FactExtractor => ({ factsOf: factsOfText });
