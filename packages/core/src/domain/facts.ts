import type { BindingKind, DeclarationKind, MemberSubject } from "./architecture-config.js";

// What a policy can know about one source file, read once. A language pack
// produces this vocabulary out of its syntax tree, and both hosts read it —
// which is what keeps them answerable to the same core rather than to each
// other. A rule is evaluated against these and nothing else.

// One name pulled across one import edge: `import { makeCommandBus } from "…"`
// is a single binding, and so is the `Effect` in `import { Effect } from "effect"`.
export type Binding = {
  readonly symbol: string;
  readonly kind: BindingKind;
  // The name the binding is known by in the importing file — `C` for
  // `import { Component as C }`, `React` for a default import — which is how
  // an identifier in the file's own syntax is traced back to the module it
  // came from. Absent for a form that binds no name.
  readonly local?: string;
};

// One declared or called name. For `members`, the declaration it is written in
// — its name and what it was declared as (`type`, `interface`, `class`); both
// absent for `calls`.
export type MemberSite = {
  readonly file: string;
  readonly subject: MemberSubject;
  readonly name: string;
  readonly in?: string;
  readonly declares?: DeclarationKind;
};

// One name a file offers, at its top level: `default` for a default export,
// `*` for `export *`, the exported (not the local) name otherwise. `declares`
// is what it was declared as when the declaration is in this file, and `other`
// for a re-export, whose declaration is elsewhere.
export type ExportSite = {
  readonly file: string;
  readonly name: string;
  readonly kind: BindingKind;
  readonly declares: DeclarationKind;
  readonly reexport: boolean;
};

export type SourceFacts = {
  // One entry per import edge, in source order. An edge appears once even if it
  // carries several bindings.
  readonly specifiers: ReadonlyArray<string>;
  // The names pulled across each edge, keyed by specifier.
  readonly bindings: ReadonlyMap<string, ReadonlyArray<Binding>>;
  readonly memberSites: ReadonlyArray<MemberSite>;
  // In source order; a file's whole surface, top-level statements only.
  readonly exportSites: ReadonlyArray<ExportSite>;
};
