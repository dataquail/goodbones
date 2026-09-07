import * as Result from "effect/Result";

import type { ManifestPath } from "../domain/manifest-location.js";

// Reuse inside a manifest, in the manifest's own schema rather than the
// format's. A top-level `defs` map names fragments; `{ use: "<name>" }`
// anywhere in the rest of the document is replaced by a deep copy of the
// fragment. This runs on the raw value before decoding, so it works the same
// in YAML, in JSON, and in a JavaScript module that chose to write it — and
// the schema that decodes the result never has to know a reference existed.
//
// There is deliberately nothing else here: no interpolation, no includes, no
// deep merge. A fragment that needs partial override is two fragments; a
// manifest that needs more than a data format offers needs a generator, and
// a generator can emit YAML.

export type ExpandIssue = {
  readonly path: ManifestPath;
  readonly detail: string;
};

// One `use` that was expanded. `at` is where the fragment landed in the
// expanded document; `ref` is where the reference was written in the original
// one; `overrides` are the keys written beside `use`, which came from the
// reference site rather than from the fragment.
export type Substitution = {
  readonly at: ManifestPath;
  readonly ref: ManifestPath;
  readonly name: string;
  readonly overrides: ReadonlySet<string>;
};

export type ExpandedManifest = {
  readonly value: unknown;
  readonly substitutions: ReadonlyArray<Substitution>;
};

// Where a path in the expanded document was written in the original one. When
// the path crosses a `use`, `via` lists each reference it passed through,
// outermost first, so an error inside a fragment can name the line that pulled
// the fragment in as well as the fragment itself.
export type Origin = {
  readonly path: ManifestPath;
  readonly via: ReadonlyArray<{ readonly at: ManifestPath; readonly name: string }>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReference = (value: unknown): value is Record<string, unknown> & { readonly use: string } =>
  isRecord(value) && typeof value.use === "string";

export const expandManifest = (input: unknown): Result.Result<ExpandedManifest, ExpandIssue> => {
  if (!isRecord(input)) return Result.succeed({ value: input, substitutions: [] });

  // Two keys the file may carry that the schema does not: the fragments, and
  // the `$schema` a JSON author writes for editor validation.
  const { $schema: _schema, defs, ...rest } = input;
  if (defs !== undefined && !isRecord(defs)) {
    return Result.fail({
      path: ["defs"],
      detail: "`defs` must be a map of named fragments.",
    });
  }
  const fragments: Record<string, unknown> = defs ?? {};
  const defined = Object.keys(fragments);
  const substitutions: Array<Substitution> = [];

  // `at` is the path in the document being built; `origin` the path in the
  // document as written; `stack` the fragments currently being expanded, for
  // the cycle check.
  const walk = (
    value: unknown,
    at: ManifestPath,
    origin: ManifestPath,
    stack: ReadonlyArray<string>,
  ): Result.Result<unknown, ExpandIssue> => {
    if (isReference(value)) {
      const { use: name, ...overrides } = value;
      if (!(name in fragments)) {
        return Result.fail({
          path: origin,
          detail:
            `\`use: ${JSON.stringify(name)}\` names no entry in \`defs\`` +
            (defined.length === 0
              ? " — the manifest defines none."
              : ` (defined: ${defined.join(", ")}).`),
        });
      }
      if (stack.includes(name)) {
        return Result.fail({
          path: origin,
          detail: `\`defs\` contains a cycle: ${[...stack, name].join(" → ")}.`,
        });
      }
      substitutions.push({ at, ref: origin, name, overrides: new Set(Object.keys(overrides)) });

      const fragment = walk(fragments[name], at, ["defs", name], [...stack, name]);
      if (Result.isFailure(fragment)) return fragment;
      if (Object.keys(overrides).length === 0) return fragment;

      if (!isRecord(fragment.success)) {
        return Result.fail({
          path: origin,
          detail:
            `\`use: ${JSON.stringify(name)}\` is written with overrides ` +
            `(${Object.keys(overrides).join(", ")}), but \`defs.${name}\` is not an object, ` +
            `so there is nothing to override.`,
        });
      }
      const merged: Record<string, unknown> = { ...fragment.success };
      for (const [key, override] of Object.entries(overrides)) {
        const expanded = walk(override, [...at, key], [...origin, key], stack);
        if (Result.isFailure(expanded)) return expanded;
        merged[key] = expanded.success;
      }
      return Result.succeed(merged);
    }

    if (Array.isArray(value)) {
      const items: Array<unknown> = [];
      for (const [index, item] of value.entries()) {
        const expanded = walk(item, [...at, index], [...origin, index], stack);
        if (Result.isFailure(expanded)) return expanded;
        items.push(expanded.success);
      }
      return Result.succeed(items);
    }

    if (isRecord(value)) {
      const entries: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const expanded = walk(item, [...at, key], [...origin, key], stack);
        if (Result.isFailure(expanded)) return expanded;
        entries[key] = expanded.success;
      }
      return Result.succeed(entries);
    }

    return Result.succeed(value);
  };

  const expanded = walk(rest, [], [], []);
  if (Result.isFailure(expanded)) return Result.fail(expanded.failure);
  return Result.succeed({ value: expanded.success, substitutions });
};

const isPrefix = (prefix: ManifestPath, path: ManifestPath): boolean =>
  prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);

// Maps a path in the expanded document back to where it was written.
export const originOf = (
  substitutions: ReadonlyArray<Substitution>,
  path: ManifestPath,
): Origin => {
  const crossed = substitutions
    .filter((one) => isPrefix(one.at, path))
    .sort((a, b) => a.at.length - b.at.length);
  const innermost = crossed.at(-1);
  if (innermost === undefined) return { path, via: [] };

  const outer = crossed.slice(0, -1).map((one) => ({ at: one.ref, name: one.name }));
  const rest = path.slice(innermost.at.length);
  const first = rest[0];

  // A key written beside `use` belongs to the reference site, not the fragment.
  if (typeof first === "string" && innermost.overrides.has(first)) {
    return { path: [...innermost.ref, ...rest], via: outer };
  }
  return {
    path: ["defs", innermost.name, ...rest],
    via: [...outer, { at: innermost.ref, name: innermost.name }],
  };
};

// The fragment a path in the expanded document was written in, when it was:
// the innermost `use` the path crossed, or nothing when the value at that path
// was authored where it sits — including a key written beside `use`, which
// belongs to the reference site.
export const fragmentOf = (
  substitutions: ReadonlyArray<Substitution>,
  path: ManifestPath,
): string | undefined => originOf(substitutions, path).via.at(-1)?.name;
