import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

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

// git exports GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and friends into the
// environment of every hook it runs, and those WIN OVER `cwd`. Everything here
// is told which repository to read — `repoRoot` — so inheriting them would make
// the nudge silently read whichever repository invoked the hook rather than the
// one it was pointed at. That is not theoretical: `campaigns status --changed`
// is designed to run from a pre-commit hook.
//
// Stripped, so `cwd` governs. In the ordinary case — a hook on the same
// repository the tool was pointed at — this changes nothing.
const AMBIENT_GIT = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_QUARANTINE_PATH",
];

export const gitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !AMBIENT_GIT.includes(key)),
  );

const git = (repoRoot: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 256 * 1024 * 1024,
  });

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

// The diff of the working tree against `base` (or HEAD), untracked files
// included as added whole.
export const readDiff = (repoRoot: string, base: string | null): Diff => {
  const against = base ?? "HEAD";
  const parsed = parseDiff(git(repoRoot, ["diff", "-U0", "--no-color", "--no-ext-diff", against]));
  const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .map((one) => one.trim())
    .filter((one) => one !== "");
  for (const file of untracked) {
    if (parsed.touched.has(file)) continue;
    parsed.touched.set(file, [{ start: 1, end: Number.MAX_SAFE_INTEGER }]);
    parsed.added.push(file);
  }
  return {
    base,
    touched: parsed.touched,
    deleted: parsed.deleted,
    added: [...new Set(parsed.added)].sort(),
  };
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

// A file's text as it was at `ref`, or `null` when it did not exist there.
export const textAt = (repoRoot: string, ref: string, file: string): string | null => {
  try {
    return git(repoRoot, ["show", `${ref}:${file}`]);
  } catch {
    return null;
  }
};

export const commitOf = (repoRoot: string, ref: string): string =>
  git(repoRoot, ["rev-parse", ref]).trim();

// The tree at `ref`, materialized in a temporary directory with the
// repository's `node_modules` linked beside it, so the packs resolve as
// they would in the checkout. The exact mode of the nudge evaluates it
// whole; the caller disposes of it.
export const materializeTree = (
  repoRoot: string,
  ref: string,
): { readonly root: string; readonly dispose: () => void } => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "goodbones-base-")));
  execFileSync(
    "sh",
    ["-c", `git archive ${JSON.stringify(ref)} | tar -x -C ${JSON.stringify(root)}`],
    {
      cwd: repoRoot,
      env: gitEnv(),
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  const modules = path.join(repoRoot, "node_modules");
  if (existsSync(modules) && !existsSync(path.join(root, "node_modules"))) {
    symlinkSync(modules, path.join(root, "node_modules"), "dir");
  }
  return {
    root,
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
};

// The commits that touched any of these paths, oldest first.
export type Commit = {
  readonly sha: string;
  readonly at: string;
  readonly subject: string;
  readonly files: ReadonlyArray<string>;
};

export const commitsTouching = (
  repoRoot: string,
  paths: ReadonlyArray<string>,
  since: string | null,
): ReadonlyArray<Commit> => {
  const range = since === null ? [] : [`${since}..HEAD`];
  const log = git(repoRoot, [
    "log",
    "--reverse",
    "--format=%x00%H%x09%aI%x09%s",
    "--name-only",
    ...range,
    "--",
    ...paths,
  ]);
  const commits: Array<Commit> = [];
  for (const block of log.split("\u0000")) {
    if (block.trim() === "") continue;
    const [head = "", ...rest] = block.split("\n");
    const [sha = "", at = "", ...subject] = head.split("\t");
    commits.push({
      sha,
      at,
      subject: subject.join("\t"),
      files: rest.map((one) => one.trim()).filter((one) => one !== ""),
    });
  }
  return commits;
};
