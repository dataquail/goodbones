import * as path from "node:path";

import { ConfigInvalid } from "../domain/architecture-error.js";
import {
  type ManifestLocator,
  type ManifestPath,
  renderManifestPath,
} from "../domain/manifest-location.js";

// A manifest split across files. `{ include: "<path>" }` standing anywhere in
// a manifest — a node under `tree`, a whole section, one entry of a list — is
// replaced by the value of the file it names, read by the same parser and
// resolved relative to the file that wrote the reference. This runs on the raw
// value before anything else looks at it: the `defs`/`use` expansion sees one
// document, the decoder sees one document, and the schema never learns that a
// reference existed.
//
// What is deliberately not here: no merging (a value is replaced, full stop),
// no parameters, no glob of files. An included file is YAML or JSON only — a
// module would make a data manifest readable by one runtime — and a file may
// carry a top-level `defs` of its own, which joins the manifest's under one
// namespace, and a `$schema` for its editor, which is dropped.

// One file, as the reader parsed it.
export type SourceDocument = {
  readonly value: unknown;
  readonly locate: ManifestLocator | undefined;
};

export type IncludeReader = {
  readonly exists: (file: string) => boolean;
  // Throws `ConfigInvalid` naming the file when it does not parse.
  readonly read: (file: string) => SourceDocument;
};

export type IncludedManifest = {
  readonly value: unknown;
  // Answers for every file: a position inside an included file carries that
  // file's path, relative to the root manifest's directory.
  readonly locate: ManifestLocator | undefined;
  // Every file that took part, root first, as absolute paths.
  readonly files: ReadonlyArray<string>;
};

const INCLUDABLE = [".yaml", ".yml", ".json"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type IncludeReference = Record<string, unknown> & { readonly include: unknown };

const isInclude = (value: unknown): value is IncludeReference =>
  isRecord(value) && "include" in value;

const isPrefix = (prefix: ManifestPath, whole: ManifestPath): boolean =>
  prefix.length <= whole.length && prefix.every((segment, index) => whole[index] === segment);

// Which file a region of the assembled document came from: everything under
// `at` was written in the file whose locator this is, starting at `origin`
// there. The root file mounts at the root; each include mounts where it
// landed; a fragment hoisted out of an included file mounts under `defs`; and
// a list item that moved — spliced in from another file, or shifted by a
// splice before it — mounts on its own, since its index is not the one it
// was written at.
type Mount = {
  readonly at: ManifestPath;
  readonly origin: ManifestPath;
  readonly label: string | undefined;
  readonly locate: ManifestLocator | undefined;
};

// The file being walked.
type Source = {
  readonly file: string;
  // How the file is named in a message: its path relative to the root
  // manifest's directory. The root file itself has none, and is named by
  // whoever reports the error.
  readonly label: string | undefined;
  readonly locate: ManifestLocator | undefined;
  // Every file on the way here, for the cycle check.
  readonly stack: ReadonlyArray<string>;
};

type Opened = {
  readonly document: SourceDocument;
  readonly source: Source;
};

const makeLocator = (mounts: ReadonlyArray<Mount>): ManifestLocator | undefined => {
  if (!mounts.some((mount) => mount.locate !== undefined)) return undefined;
  return (manifestPath) => {
    const innermost = mounts
      .filter((mount) => isPrefix(mount.at, manifestPath))
      .sort((a, b) => a.at.length - b.at.length)
      .at(-1);
    if (innermost === undefined) return null;
    const found =
      innermost.locate?.([...innermost.origin, ...manifestPath.slice(innermost.at.length)]) ?? null;
    if (found === null) return null;
    return innermost.label === undefined ? found : { ...found, file: innermost.label };
  };
};

export const expandIncludes = (
  rootPath: string,
  root: SourceDocument,
  reader: IncludeReader,
): IncludedManifest => {
  const rootDirectory = path.dirname(rootPath);
  const labelOf = (file: string): string =>
    path.relative(rootDirectory, file).split(path.sep).join("/");
  const nameOf = (source: Source): string => source.label ?? path.basename(rootPath);

  const files: Array<string> = [rootPath];
  const mounts: Array<Mount> = [{ at: [], origin: [], label: undefined, locate: root.locate }];
  // Fragments hoisted out of included files, and the file each name came from.
  const hoisted: Record<string, unknown> = {};
  const definedIn = new Map<string, string>();

  const refuse = (source: Source, origin: ManifestPath, detail: string): never => {
    const position = source.locate?.(origin) ?? null;
    const at =
      position === null
        ? ""
        : `${nameOf(source)}:${String(position.line)}:${String(position.column)}  `;
    throw new ConfigInvalid({
      configPath: rootPath,
      detail: `the manifest does not include:\n  ${at}${renderManifestPath(origin)}: ${detail}`,
    });
  };

  // Checks a reference and reads the file it names. Nothing is placed yet:
  // where the value lands depends on whether it is a list spliced into a list.
  const open = (reference: IncludeReference, origin: ManifestPath, source: Source): Opened => {
    const { include: specifier, ...rest } = reference;
    if (typeof specifier !== "string") {
      return refuse(source, origin, "`include` names a file, as a string.");
    }
    const shown = `\`include: ${JSON.stringify(specifier)}\``;
    const beside = Object.keys(rest);
    if (beside.length > 0) {
      return refuse(
        source,
        origin,
        `${shown} stands alone: an included file is replaced whole, so there is nothing for ` +
          `${beside.map((key) => `\`${key}\``).join(", ")} to override. ` +
          `To override a fragment, put it under \`defs\` and \`use\` it.`,
      );
    }
    const target = path.resolve(path.dirname(source.file), specifier);
    if (!INCLUDABLE.includes(path.extname(target).toLowerCase())) {
      return refuse(
        source,
        origin,
        `${shown} names a file that is not YAML or JSON. Only a data file can be included: ` +
          `a module would make the manifest readable by one runtime only.`,
      );
    }
    if (source.stack.includes(target)) {
      return refuse(
        source,
        origin,
        `${shown} includes a file that is already being included: ` +
          `${[...source.stack, target].map(labelOf).join(" → ")}.`,
      );
    }
    if (!reader.exists(target)) {
      return refuse(
        source,
        origin,
        `${shown} names a file that does not exist (looked for ${labelOf(target)}, ` +
          `relative to ${nameOf(source)}).`,
      );
    }
    const document = reader.read(target);
    files.push(target);
    return {
      document,
      source: {
        file: target,
        label: labelOf(target),
        locate: document.locate,
        stack: [...source.stack, target],
      },
    };
  };

  // Places an opened file at `at`, whole, and walks it so no reference is
  // left inside. A top-level `defs` in the file joins the root's, and its
  // `$schema` is for the editor — unless the file was included somewhere
  // under `defs`, where it is a fragment or the map itself, and a key by
  // either name is the author's.
  const place = (opened: Opened, at: ManifestPath): unknown => {
    const { document, source } = opened;
    mounts.push({ at, origin: [], label: source.label, locate: source.locate });
    if (!isRecord(document.value) || at[0] === "defs") {
      return walk(document.value, at, [], source);
    }
    const { $schema: _schema, defs, ...body } = document.value;
    if (defs !== undefined) {
      if (!isRecord(defs)) {
        return refuse(source, ["defs"], "`defs` must be a map of named fragments.");
      }
      for (const [name, fragment] of Object.entries(defs)) {
        const already = definedIn.get(name);
        if (already !== undefined) {
          return refuse(
            source,
            ["defs", name],
            `\`defs.${name}\` is already defined in ${already}. Every file's \`defs\` share ` +
              `one namespace; rename one of them.`,
          );
        }
        definedIn.set(name, nameOf(source));
        mounts.push({
          at: ["defs", name],
          origin: ["defs", name],
          label: source.label,
          locate: source.locate,
        });
        hoisted[name] = walk(fragment, ["defs", name], ["defs", name], source);
      }
    }
    return walk(body, at, [], source);
  };

  // Appends each item of `list` to `items`. An include standing as an item
  // whose file holds a list is spliced in, so a list can be split across
  // files; an item that does not sit at the index it was written at is
  // mounted on its own.
  const append = (
    items: Array<unknown>,
    list: ReadonlyArray<unknown>,
    at: ManifestPath,
    origin: ManifestPath,
    source: Source,
    spliced: boolean,
  ): void => {
    for (const [index, item] of list.entries()) {
      const itemOrigin = [...origin, index];
      const slot = [...at, items.length];
      if (isInclude(item)) {
        const opened = open(item, itemOrigin, source);
        if (Array.isArray(opened.document.value)) {
          append(items, opened.document.value, at, [], opened.source, true);
        } else {
          items.push(place(opened, slot));
        }
        continue;
      }
      if (spliced || items.length !== index) {
        mounts.push({ at: slot, origin: itemOrigin, label: source.label, locate: source.locate });
      }
      items.push(walk(item, slot, itemOrigin, source));
    }
  };

  const walk = (
    value: unknown,
    at: ManifestPath,
    origin: ManifestPath,
    source: Source,
  ): unknown => {
    if (isInclude(value)) return place(open(value, origin, source), at);

    if (Array.isArray(value)) {
      const items: Array<unknown> = [];
      append(items, value, at, origin, source, false);
      return items;
    }

    if (isRecord(value)) {
      const entries: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        entries[key] = walk(item, [...at, key], [...origin, key], source);
      }
      return entries;
    }

    return value;
  };

  const rootSource: Source = {
    file: rootPath,
    label: undefined,
    locate: root.locate,
    stack: [rootPath],
  };
  const value = walk(root.value, [], [], rootSource);

  // Nothing was included: the value and the locator are the reader's own.
  if (files.length === 1) return { value, locate: root.locate, files };

  const names = Object.keys(hoisted);
  if (names.length === 0 || !isRecord(value)) {
    return { value, locate: makeLocator(mounts), files };
  }

  const own = value.defs;
  if (own !== undefined && !isRecord(own)) {
    return refuse(rootSource, ["defs"], "`defs` must be a map of named fragments.");
  }
  for (const name of names) {
    if (own !== undefined && name in own) {
      return refuse(
        rootSource,
        ["defs", name],
        `\`defs.${name}\` is also defined in ${definedIn.get(name) ?? "an included file"}. ` +
          `Every file's \`defs\` share one namespace; rename one of them.`,
      );
    }
  }
  return {
    value: { ...value, defs: { ...(own ?? {}), ...hoisted } },
    locate: makeLocator(mounts),
    files,
  };
};
