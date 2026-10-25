import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { gitEnv, makeGitClientLive } from "./git.client-live.js";

// A repository of one commit: `a.txt` and a ledger under a folder. Built
// with git's ambient variables stripped, as the client runs it: under a
// pre-commit hook GIT_DIR and GIT_INDEX_FILE point at the repository being
// committed, and would win over `cwd`.
const repository = (): string => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "goodbones-git-")));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const git = (...args: ReadonlyArray<string>) =>
    execFileSync("git", args, { cwd: root, env: gitEnv(), stdio: ["ignore", "pipe", "ignore"] });

  git("init", "-q");
  git("config", "user.email", "a@example.com");
  git("config", "user.name", "A");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "one\ntwo\n");
  mkdirSync(path.join(root, "ledgers"));
  writeFileSync(path.join(root, "ledgers/x.json"), "{}\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");

  return root;
};

describe("makeGitClientLive", () => {
  it("reads the working tree's diff against HEAD, untracked files added whole", () => {
    const root = repository();
    writeFileSync(path.join(root, "a.txt"), "one\nTWO\n");
    writeFileSync(path.join(root, "b.txt"), "new\n");
    const diff = makeGitClientLive(root).diff(null);

    expect(diff.base).toBeNull();
    expect(diff.touched.get("a.txt")).toEqual([{ start: 2, end: 2 }]);
    expect(diff.added).toEqual(["b.txt"]);
  });

  it("reads a file, a commit and the log as they were", () => {
    const root = repository();
    const git = makeGitClientLive(root);

    expect(git.textAt("HEAD", "a.txt")).toBe("one\ntwo\n");
    expect(git.textAt("HEAD", "absent.txt")).toBeNull();
    expect(git.commitOf("HEAD")).toMatch(/^[0-9a-f]{40}$/);
    expect(git.commitsTouching(["ledgers"], null).map((one) => [one.subject, one.files])).toEqual([
      ["first", ["ledgers/x.json"]],
    ]);
    expect(() => git.commitOf("no-such-ref")).toThrow();
    // Where the fake must answer alike: an unknown ref reads no file, and a
    // log since one is refused.
    expect(git.textAt("no-such-ref", "a.txt")).toBeNull();
    expect(() => git.commitsTouching(["ledgers"], "no-such-ref")).toThrow();
  });

  it("reads the tree at a ref as a file system", () => {
    const root = repository();
    const tree = makeGitClientLive(root).fileSystemAt("HEAD");

    expect(tree.list("ledgers")).toEqual(["x.json"]);
    expect(tree.list("absent")).toEqual([]);
    expect(tree.exists("ledgers/x.json")).toBe(true);
    expect(tree.exists("ledgers/y.json")).toBe(false);
    expect(tree.readText("ledgers/x.json")).toBe("{}\n");
  });

  it("materializes the tree at a ref, and disposes of it", () => {
    const root = repository();
    const tree = makeGitClientLive(root).materializeTree("HEAD");

    expect(execFileSync("cat", [path.join(tree.root, "a.txt")], { encoding: "utf8" })).toBe(
      "one\ntwo\n",
    );
    tree.dispose();
    expect(() => execFileSync("ls", [tree.root], { stdio: "ignore" })).toThrow();
  });
});
