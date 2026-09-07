import * as path from "node:path";

// The seam a second language fills. A scenario speaks in files, a manifest
// and CLI output; the profile is the one place that knows how a file which
// imports these and exports those is spelled, what a repository of the
// language needs beside its source, and how an external package is stubbed so
// resolution runs the way it does anywhere. Adding a language to this suite is
// adding a profile and a `resolve.scopes` entry; the scenarios do not change.

export type ImportSpec =
  // A side-effect import: an edge with no bindings.
  | string
  // Named bindings — the form the `exports` family judges.
  | { readonly from: string; readonly names: ReadonlyArray<string> }
  // The whole module under one name.
  | { readonly from: string; readonly namespace: string };

export type Declaration =
  // A declared shape with these members — what a `members` rule about
  // `subject: members` reads.
  | { readonly type: string; readonly members: ReadonlyArray<string> }
  // A bare call by this name — what `subject: calls` reads.
  | { readonly calls: string };

export type FileSpec = {
  readonly imports: ReadonlyArray<ImportSpec>;
  readonly exports: ReadonlyArray<string>;
  readonly declares: ReadonlyArray<Declaration>;
};

// A literal source, or a spec the profile renders.
export type FileContent = string | FileSpec;

export type Profile = {
  // The manifest's `language`.
  readonly language: string;
  readonly extension: string;
  readonly render: (spec: FileSpec) => string;
  // Files a repository of this language needs beside its source.
  readonly support: Readonly<Record<string, string>>;
  // The `resolve.scopes` entry a manifest over such a repository names.
  readonly scope: Readonly<Record<string, unknown>>;
  // An external package exposing these subpaths, as files under the
  // repository's own `node_modules/`.
  readonly stub: (
    name: string,
    subpaths: ReadonlyArray<string>,
  ) => Readonly<Record<string, string>>;
  // How one repo-relative file names another.
  readonly specifier: (from: string, to: string) => string;
};

export const source = (spec: Partial<FileSpec>): FileSpec => ({
  imports: [],
  exports: [],
  declares: [],
  ...spec,
});

export const imports = (...specs: ReadonlyArray<ImportSpec>): FileSpec =>
  source({ imports: specs });

export const exports = (...names: ReadonlyArray<string>): FileSpec => source({ exports: names });

export const declares = (...declarations: ReadonlyArray<Declaration>): FileSpec =>
  source({ declares: declarations });

const renderTypeScript = (spec: FileSpec): string => {
  const lines: Array<string> = [];
  for (const one of spec.imports) {
    if (typeof one === "string") lines.push(`import "${one}";`);
    else if ("names" in one) lines.push(`import { ${one.names.join(", ")} } from "${one.from}";`);
    else lines.push(`import * as ${one.namespace} from "${one.from}";`);
  }
  for (const name of spec.exports) lines.push(`export const ${name} = 1;`);
  for (const declaration of spec.declares) {
    if ("type" in declaration) {
      const members = declaration.members.map((member) => `${member}(): void`).join("; ");
      lines.push(`export type ${declaration.type} = { ${members} };`);
    } else {
      lines.push(`${declaration.calls}();`);
    }
  }
  if (lines.length === 0) lines.push("export {};");
  return `${lines.join("\n")}\n`;
};

export const typescript: Profile = {
  language: "typescript",
  extension: ".ts",
  render: renderTypeScript,
  support: {
    "package.json": `${JSON.stringify({ name: "fixture", private: true, type: "module" }, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify({ compilerOptions: { baseUrl: "." } }, null, 2)}\n`,
  },
  scope: { files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } },
  stub: (name, subpaths) => ({
    [`node_modules/${name}/package.json`]: `${JSON.stringify(
      {
        name,
        version: "1.0.0",
        type: "module",
        exports: {
          ".": "./index.js",
          ...Object.fromEntries(subpaths.map((subpath) => [`./${subpath}`, `./${subpath}.js`])),
        },
      },
      null,
      2,
    )}\n`,
    [`node_modules/${name}/index.js`]: "export const index = 1;\n",
    ...Object.fromEntries(
      subpaths.map((subpath) => [
        `node_modules/${name}/${subpath}.js`,
        `export const ${subpath.replaceAll(/\W/g, "_")} = 1;\n`,
      ]),
    ),
  }),
  specifier: (from, to) => {
    const relative = path.posix.relative(path.posix.dirname(from), to);
    return relative.startsWith(".") ? relative : `./${relative}`;
  },
};
