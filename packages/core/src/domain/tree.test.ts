import { describe, expect, it } from "vitest";

import {
  ancestorsOf,
  deepestContaining,
  eachNode,
  filesBeneath,
  findFolder,
  folderAt,
  isUnder,
  makeFolder,
  trieOf,
} from "./tree.js";

const FILES = [
  "src/server.ts",
  "src/modules/auth/index.ts",
  "src/modules/auth/domain/user.ts",
  "src/modules/billing/index.ts",
  "lib/legacy.ts",
  "scripts/build.ts",
];

describe("trieOf", () => {
  it("files each file under its folder, one trie per root, and drops the rest", () => {
    const [src, lib] = trieOf(FILES, ["src", "lib"]);
    expect(src?.files).toEqual(["src/server.ts"]);
    expect([...(src?.children.keys() ?? [])]).toEqual(["modules"]);
    expect(
      findFolder(
        [src, lib].flatMap((one) => (one === undefined ? [] : [one])),
        "src/modules/auth",
      )?.files,
    ).toEqual(["src/modules/auth/index.ts"]);
    expect(lib?.files).toEqual(["lib/legacy.ts"]);
    expect(
      findFolder(
        [src, lib].flatMap((one) => (one === undefined ? [] : [one])),
        "scripts",
      ),
    ).toBeNull();
  });

  it("files a path where `folderOf` says, so generalized members merge", () => {
    const [src] = trieOf(FILES, ["src"], (file) =>
      file.replace(/^src\/modules\/[^/]+/, "src/modules/{module}").replace(/\/[^/]+$/, ""),
    );
    const merged = findFolder(src === undefined ? [] : [src], "src/modules/{module}");
    expect(merged?.files.sort()).toEqual([
      "src/modules/auth/index.ts",
      "src/modules/billing/index.ts",
    ]);
  });

  it("lists every file beneath a folder, and reaches every node in pre-order", () => {
    const tries = trieOf(FILES, ["src"]);
    const [src] = tries;
    if (src === undefined) throw new Error("no trie");
    expect([...filesBeneath(src)].sort()).toEqual(
      FILES.filter((file) => file.startsWith("src/")).sort(),
    );
    const visited: Array<string> = [];
    eachNode(tries, (folder) => visited.push(folder.path));
    expect(visited).toEqual([
      "src",
      "src/modules",
      "src/modules/auth",
      "src/modules/auth/domain",
      "src/modules/billing",
    ]);
  });
});

describe("folderAt and deepestContaining", () => {
  it("creates the missing ancestors, and finds the deepest node holding a path", () => {
    const root = makeFolder("");
    const deep = folderAt(root, "a/b/c");
    expect(deep.path).toBe("a/b/c");
    expect(deep.name).toBe("c");
    expect(root.children.get("a")?.children.get("b")?.children.get("c")).toBe(deep);
    expect(deepestContaining([root], "a/b/c/d.ts")?.path).toBe("a/b/c");
    expect(deepestContaining([root], "a/x.ts")?.path).toBe("a");
    expect(deepestContaining([makeFolder("src")], "lib/x.ts")).toBeNull();
  });
});

describe("paths", () => {
  it("knows what is under what, and every ancestor nearest first", () => {
    expect(isUnder("a/b/c.ts", "a")).toBe(true);
    expect(isUnder("a/b/c.ts", "a/b")).toBe(true);
    expect(isUnder("ab/c.ts", "a")).toBe(false);
    expect(isUnder("anything", "")).toBe(true);
    expect(ancestorsOf("a/b/c.ts")).toEqual(["a/b", "a"]);
    expect(ancestorsOf("c.ts")).toEqual([]);
  });
});
