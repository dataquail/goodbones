import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { FileSystem } from "@goodbones/core";

import type { Commit } from "../../domain/git/commit.value-object.js";
import { type Diff, parseDiff } from "../../domain/git/diff.value-object.js";
import type { GitClient } from "../../domain/ports/clients/git.client.js";

// The git client over the `git` binary, run in the repository it is told
// to read. Each member is also exported on its own, as the family's barrel
// has always offered them, for a host that reads git without a policy.

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

// Every git run here reads. `GIT_OPTIONAL_LOCKS=0` keeps a read from
// refreshing the index as a side effect — which a host watching the index
// for commits would see as a change of its own making.
export const gitEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !AMBIENT_GIT.includes(key))),
  GIT_OPTIONAL_LOCKS: "0",
});

const git = (repoRoot: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 256 * 1024 * 1024,
  });

// Where git keeps `HEAD` and the index for this working tree, absolute. A
// commit, a checkout and a `git add` change nothing a walk of the tree sees,
// and each changes what a diff against `HEAD` says, so a host that redraws
// on change watches these two. A linked worktree keeps them outside its own
// folder, which is why git is asked rather than `.git/` assumed. `null`
// where git does not answer.
export const gitPathsOf = (
  repoRoot: string,
): { readonly head: string; readonly index: string } | null => {
  try {
    const at = (name: string): string =>
      path.resolve(repoRoot, git(repoRoot, ["rev-parse", "--git-path", name]).trim());

    return { head: at("HEAD"), index: at("index") };
  } catch {
    return null;
  }
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

// The tree at `ref`, read as the core reads any file. A path absent there
// does not exist, reads as `null` and lists nothing.
export const fileSystemAt = (repoRoot: string, ref: string): FileSystem => ({
  exists: (file) => {
    try {
      git(repoRoot, ["cat-file", "-e", `${ref}:${file}`]);

      return true;
    } catch {
      return false;
    }
  },
  readText: (file) => textAt(repoRoot, ref, file),
  list: (dir) => {
    try {
      return git(repoRoot, ["ls-tree", "--name-only", `${ref}:${dir}`])
        .split("\n")
        .filter((one) => one !== "")
        .sort();
    } catch {
      return [];
    }
  },
});

// The author of a concession: `--by`, else git's user.email, else the
// GIT_AUTHOR_EMAIL the environment carries. Without one the record is
// refused rather than written blank, since the record is the point.
export const authorOf = (given: string | undefined): string | null => {
  if (given !== undefined && given !== "") return given;

  try {
    const email = execFileSync("git", ["config", "user.email"], {
      env: gitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (email !== "") return email;
  } catch {
    // git absent, or no email configured
  }

  const fromEnvironment = process.env.GIT_AUTHOR_EMAIL;

  return fromEnvironment === undefined || fromEnvironment === "" ? null : fromEnvironment;
};

export const makeGitClientLive = (repoRoot: string): GitClient => ({
  diff: (base) => readDiff(repoRoot, base),
  textAt: (ref, file) => textAt(repoRoot, ref, file),
  commitOf: (ref) => commitOf(repoRoot, ref),
  materializeTree: (ref) => materializeTree(repoRoot, ref),
  commitsTouching: (paths, since) => commitsTouching(repoRoot, paths, since),
  fileSystemAt: (ref) => fileSystemAt(repoRoot, ref),
});
