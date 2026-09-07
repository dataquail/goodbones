import { existsSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

import type { Language } from "../ports/language.js";

// Folders no policy is written about and no linter visits. These are the right
// defaults for any language on this host: a package store, build output, the
// VCS, and a coverage report are never the architecture.
const SKIPPED = new Set([
  "node_modules",
  "build",
  "dist",
  ".next",
  ".git",
  "storybook-static",
  "coverage",
]);

// What the walker needs to know about a language: what a source file of it is
// called, and which of those are not source after all.
export type WalkedLanguage = Pick<Language, "extensions" | "ignoredFiles">;

// The source files under `roots`, repo-relative with forward slashes, sorted.
// Which files count as source is the languages' to say: the extension set is
// the union of theirs, and so is the set of files to step over. A root that
// names a file is that file, whatever its extension — `architecture check
// <file>` is a reasonable thing to type.
export const listSourceFiles = (
  repoRoot: string,
  roots: ReadonlyArray<string>,
  languages: ReadonlyArray<WalkedLanguage>,
): ReadonlyArray<string> => {
  const extensions = new Set(languages.flatMap((language) => language.extensions));
  const ignored = languages.flatMap((language) => language.ignoredFiles);
  const isSource = (entry: string): boolean =>
    extensions.has(path.extname(entry)) && !ignored.some((pattern) => pattern.test(entry));

  const found: Array<string> = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute)) {
      if (SKIPPED.has(entry)) continue;
      const child = path.join(absolute, entry);
      if (statSync(child).isDirectory()) walk(child);
      else if (isSource(entry))
        found.push(path.relative(repoRoot, child).replaceAll(path.sep, "/"));
    }
  };
  for (const root of roots) {
    const absolute = path.resolve(repoRoot, root);
    if (statSync(absolute).isDirectory()) walk(absolute);
    else found.push(path.relative(repoRoot, absolute).replaceAll(path.sep, "/"));
  }
  return found.sort();
};

// What `infer` needs to know about a language beyond the walker's two: what
// marks a package of it, and where a package keeps its source.
export type PackagedLanguage = Pick<Language, "packageMarkers" | "sourceRoots">;

export type PackageRoot = {
  // Repo-relative folder with forward slashes; `""` is the repository itself.
  readonly root: string;
  // The package's source folder, repo-relative, when one of the language's
  // `sourceRoots` exists under it; otherwise `null`, and source sits at the root.
  readonly source: string | null;
};

// The packages under (and above) `roots`: every folder holding one of the
// languages' marker files, the walk roots' own ancestors included, so a walk
// rooted at `src/` still finds the `package.json` beside it. Sorted by path.
export const listPackageRoots = (
  repoRoot: string,
  roots: ReadonlyArray<string>,
  languages: ReadonlyArray<PackagedLanguage>,
): ReadonlyArray<PackageRoot> => {
  const markers = languages.flatMap((language) => language.packageMarkers);
  const sourceRoots = languages.flatMap((language) => language.sourceRoots);
  if (markers.length === 0) return [];

  const isDirectory = (absolute: string): boolean => {
    try {
      return statSync(absolute).isDirectory();
    } catch {
      return false;
    }
  };
  const relative = (absolute: string): string =>
    path.relative(repoRoot, absolute).replaceAll(path.sep, "/");

  const found = new Map<string, PackageRoot>();
  const consider = (absolute: string): void => {
    const key = relative(absolute);
    if (found.has(key)) return;
    if (!markers.some((marker) => existsSync(path.join(absolute, marker)))) return;
    const source = sourceRoots.find((name) => isDirectory(path.join(absolute, name)));
    found.set(key, {
      root: key,
      source: source === undefined ? null : relative(path.join(absolute, source)),
    });
  };
  const walk = (absolute: string): void => {
    consider(absolute);
    for (const entry of readdirSync(absolute)) {
      if (SKIPPED.has(entry)) continue;
      const child = path.join(absolute, entry);
      if (isDirectory(child)) walk(child);
    }
  };

  const top = path.resolve(repoRoot);
  for (const root of roots) {
    let absolute = path.resolve(repoRoot, root);
    if (!isDirectory(absolute)) absolute = path.dirname(absolute);
    walk(absolute);
    // The ancestors, up to the repository: a package is as often above the
    // walk root as inside it.
    for (let above = absolute; above.startsWith(top); above = path.dirname(above)) {
      consider(above);
      if (above === top) break;
    }
  }
  return [...found.values()].sort((a, b) => a.root.localeCompare(b.root));
};
