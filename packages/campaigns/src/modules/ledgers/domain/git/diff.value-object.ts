// What the nudge is scoped to: the files a diff touches, and where in each.
// Read from git — the working tree against `HEAD` on a developer's machine,
// or against `--base <ref>` in CI — with `-U0`, so a hunk is exactly the
// lines that changed and "nearest your change" means something.

export type Hunk = {
  // One-based, inclusive, in the new file; a pure deletion is a zero-length
  // hunk at the line after it.
  readonly start: number;
  readonly end: number;
};

export type Diff = {
  // The ref the diff was taken against; `null` for the working tree
  // against HEAD.
  readonly base: string | null;
  // Repo-relative paths, forward slashes, with the hunks in each. A file
  // added whole has one hunk covering it; a deleted file is not here.
  readonly touched: ReadonlyMap<string, ReadonlyArray<Hunk>>;
  readonly deleted: ReadonlyArray<string>;
  readonly added: ReadonlyArray<string>;
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

// Parses `git diff -U0`: one entry per file header, one hunk per `@@`. An
// empty file added or deleted has a header and a mode line and nothing
// else, so the mode lines are read too.
export const parseDiff = (
  text: string,
): { touched: Map<string, Array<Hunk>>; deleted: Array<string>; added: Array<string> } => {
  const touched = new Map<string, Array<Hunk>>();
  const deleted = new Set<string>();
  const added = new Set<string>();
  let current: string | null = null;

  for (const line of text.split("\n")) {
    const header = HEADER.exec(line);

    if (header !== null) {
      current = header[2] ?? null;
      continue;
    }

    if (current === null) continue;

    if (line.startsWith("deleted file mode")) {
      deleted.add(current);
      touched.delete(current);
      continue;
    }

    if (line.startsWith("new file mode")) {
      added.add(current);

      if (!touched.has(current)) touched.set(current, []);
      continue;
    }

    if (line.startsWith("+++ ")) {
      if (line.slice(4) === "/dev/null") {
        deleted.add(current);
        touched.delete(current);
      } else if (!deleted.has(current) && !touched.has(current)) {
        touched.set(current, []);
      }

      continue;
    }

    const hunk = HUNK.exec(line);

    if (hunk !== null && !deleted.has(current)) {
      const start = Number(hunk[3]);
      const count = hunk[4] === undefined ? 1 : Number(hunk[4]);
      const hunks = touched.get(current) ?? [];
      hunks.push({ start, end: count === 0 ? start : start + count - 1 });
      touched.set(current, hunks);
    }
  }

  // A file added whole with no hunk of its own (empty) covers itself.
  for (const file of added) {
    if ((touched.get(file) ?? []).length === 0) touched.set(file, [{ start: 1, end: 1 }]);
  }

  return { touched, deleted: [...deleted].sort(), added: [...added].sort() };
};

// The distance, in lines, from a range to the nearest hunk of a file: zero
// when they overlap. `Infinity` for a file with no hunk.
export const distanceToHunks = (hunks: ReadonlyArray<Hunk>, start: number, end: number): number => {
  let nearest = Number.POSITIVE_INFINITY;

  for (const hunk of hunks) {
    const distance = hunk.end < start ? start - hunk.end : end < hunk.start ? hunk.start - end : 0;

    if (distance < nearest) nearest = distance;
  }

  return nearest;
};
