import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  listPackageRoots,
  listSourceFiles,
  type PackagedLanguage,
  type WalkedLanguage,
} from "./walk.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

// What the TypeScript pack says of itself, restated: the walker is tested
// against a shape, not against a package the core may not depend on.
const TYPESCRIPT: ReadonlyArray<WalkedLanguage> = [
  { extensions: [".ts", ".tsx", ".mts", ".cts"], ignoredFiles: [/\.d\.[cm]?ts$/] },
];

// A language that does not exist, with an extension no TypeScript file has.
const GO: WalkedLanguage = { extensions: [".go"], ignoredFiles: [/_test\.go$/] };

const fixture = (files: ReadonlyArray<string>, run: (root: string) => void): void => {
  const root = mkdtempSync(path.join(tmpdir(), "architecture-walk-"));
  try {
    for (const file of files) writeFileSync(path.join(root, file), "");
    run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe("listSourceFiles", () => {
  it("finds the sources under a root", () => {
    const files = listSourceFiles(repoRoot, ["packages/core/src/core"], TYPESCRIPT);
    expect(files).toContain("packages/core/src/core/baseline.ts");
  });

  // A declaration file states types, not code; no linter visits one. The
  // fixture is written rather than pointed at a directory that happens to hold
  // a `.d.ts` today — a repository that stops emitting declarations beside its
  // sources would turn that into a test asserting nothing.
  it("skips the files a language says are not source", () => {
    fixture(["thing.ts", "thing.d.ts", "thing.d.mts"], (root) => {
      expect(listSourceFiles(root, ["."], TYPESCRIPT)).toEqual(["thing.ts"]);
    });
  });

  // The extension set is the languages', not the walker's. Nothing here knows
  // what a TypeScript file is called.
  it("visits the files of whichever languages it is given, and only those", () => {
    fixture(["a.ts", "b.go", "b_test.go", "c.md"], (root) => {
      expect(listSourceFiles(root, ["."], TYPESCRIPT)).toEqual(["a.ts"]);
      expect(listSourceFiles(root, ["."], [GO])).toEqual(["b.go"]);
      expect(listSourceFiles(root, ["."], [...TYPESCRIPT, GO])).toEqual(["a.ts", "b.go"]);
      expect(listSourceFiles(root, ["."], [])).toEqual([]);
    });
  });

  it("skips the folders no policy is written about", () => {
    expect(
      listSourceFiles(repoRoot, ["packages/core"], TYPESCRIPT).some((f) =>
        /node_modules|\/build\//.test(f),
      ),
    ).toBe(false);
  });
});

describe("roots", () => {
  // `architecture check <file>` is a reasonable thing to type, so a root that
  // names one file is that file rather than a directory to walk.
  it("takes a root that names a file as the file itself", () => {
    expect(listSourceFiles(repoRoot, ["packages/core/src/core/baseline.ts"], TYPESCRIPT)).toEqual([
      "packages/core/src/core/baseline.ts",
    ]);
  });
});

describe("listPackageRoots", () => {
  const NODE: PackagedLanguage = { packageMarkers: ["package.json"], sourceRoots: ["src"] };
  const GO_MODULES: PackagedLanguage = { packageMarkers: ["go.mod"], sourceRoots: [] };

  const nested = (files: ReadonlyArray<string>, run: (root: string) => void): void => {
    const root = mkdtempSync(path.join(tmpdir(), "architecture-packages-"));
    try {
      for (const file of files) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), "");
      }
      run(root);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  };

  const TREE = [
    "package.json",
    "src/a.ts",
    "packages/x/package.json",
    "packages/x/src/b.ts",
    "packages/y/go.mod",
    "packages/y/c.go",
    "packages/z/node_modules/dep/package.json",
    "packages/z/d.ts",
  ];

  it("finds every folder holding a marker, the walk root's ancestors included", () => {
    nested(TREE, (root) => {
      expect(listPackageRoots(root, ["packages"], [NODE])).toEqual([
        { root: "", source: "src" },
        { root: "packages/x", source: "packages/x/src" },
      ]);
      expect(listPackageRoots(root, ["src"], [NODE])).toEqual([{ root: "", source: "src" }]);
    });
  });

  it("marks a package by whichever language's file it holds, and its source by the language's convention", () => {
    nested(TREE, (root) => {
      expect(listPackageRoots(root, ["packages"], [NODE, GO_MODULES])).toEqual([
        { root: "", source: "src" },
        { root: "packages/x", source: "packages/x/src" },
        { root: "packages/y", source: null },
      ]);
      expect(listPackageRoots(root, ["packages"], [])).toEqual([]);
    });
  });

  it("skips the folders the walker skips", () => {
    nested(TREE, (root) => {
      expect(
        listPackageRoots(root, ["packages"], [NODE]).some((one) =>
          one.root.includes("node_modules"),
        ),
      ).toBe(false);
    });
  });
});
