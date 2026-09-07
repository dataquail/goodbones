import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { check, cli } from "../cli.js";
import {
  EVERY_FAMILY_ROOTS,
  everyFamilyFiles,
  everyFamilyFingerprints,
  everyFamilyManifest,
} from "../fixtures/every-family.js";
import { type Installed, installPacked, packAll, type Tarballs } from "../install.js";
import { oxlint } from "../oxlint.js";
import { createRepo, type Repo } from "../repo.js";

// The packages as npm ships them, installed into the fixture and run from
// there: the bin resolves, the plugin's default export loads, the `exports`
// maps hold, and an emitted specifier that typechecks but does not run is
// found here rather than by whoever installs the package.

let packed: string;
let tarballs: Tarballs;
let repo: Repo;
let installed: Installed;

beforeAll(() => {
  packed = realpathSync(mkdtempSync(path.join(tmpdir(), "goodbones-pack-")));
  tarballs = packAll(packed);
  repo = createRepo({ files: everyFamilyFiles });
  repo.writeManifest(everyFamilyManifest(repo.profile));
  installed = installPacked(repo, tarballs);
});

afterAll(() => {
  repo.dispose();
  rmSync(packed, { force: true, recursive: true });
});

const walk = (root: string): ReadonlyArray<string> =>
  readdirSync(root).flatMap((entry) => {
    const at = path.join(root, entry);
    return statSync(at).isDirectory() ? walk(at) : [at];
  });

describe("installed shape", () => {
  it("ships the build and the source, and no test", () => {
    for (const at of Object.values(installed.packages)) {
      const files = walk(at).map((file) => path.relative(at, file));
      expect(files).toContain("package.json");
      expect(files.some((file) => file.startsWith("build/esm/"))).toBe(true);
      expect(files.some((file) => file.startsWith("build/dts/"))).toBe(true);
      expect(files.some((file) => file.endsWith(".test.ts"))).toBe(false);
    }
  });

  it("runs the installed bin, which reports what this checkout's does", () => {
    const fromCheckout = check(repo, EVERY_FAMILY_ROOTS);
    const fromInstall = check(repo, EVERY_FAMILY_ROOTS, { bin: installed.bin });
    expect(fromInstall.code).toBe(1);
    expect(fromInstall.json).toEqual(fromCheckout.json);
    expect(fromInstall.json.violations.map((one) => one.fingerprint).sort()).toEqual(
      [...Object.values(everyFamilyFingerprints)].sort(),
    );
  });

  it("is executable through the .bin link, shebang and all", () => {
    const run = spawnSync(installed.bin, ["check", "--json", ...EVERY_FAMILY_ROOTS], {
      cwd: repo.root,
      encoding: "utf8",
    });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect((JSON.parse(run.stdout) as { files: number }).files).toBe(10);
  });

  it("init and explain run from the install too", () => {
    const fresh = createRepo({ files: { "src/main.ts": "export const main = 1;\n" } });
    try {
      const wrote = cli(fresh, ["init"], { bin: installed.bin });
      expect(wrote.code, wrote.stderr).toBe(0);
      expect(fresh.exists("architecture.yaml")).toBe(true);
      // The install's core is what resolves and walks; the checkout's is not
      // on the path from here.
      const explained = cli(fresh, ["explain", "src/main.ts"], { bin: installed.bin });
      expect(explained.code, explained.stderr).toBe(0);
      expect(explained.stdout).toContain("src/imports");
    } finally {
      fresh.dispose();
    }
  });

  it("loads the plugin by its package name through the exports map", () => {
    const linted = oxlint(repo, EVERY_FAMILY_ROOTS, { plugin: "@goodbones/oxlint" });
    expect(linted.loaded, linted.stdout + linted.stderr).toBe(true);
    expect(linted.code).toBe(1);
    expect(linted.diagnostics.map((one) => `${one.rule} ${one.file}`).sort()).toEqual(
      [
        "architecture/exports src/ports/thing.repository.ts",
        "architecture/imports src/ports/thing.repository.ts",
        "architecture/members src/ports/thing.repository.ts",
        "architecture/members src/thing.view.ts",
        "architecture/structure src/ports/stray.ts",
        "architecture/structure src/ports/thing.repository.ts",
        "architecture/surface src/thing.view.ts",
      ].sort(),
    );
  });

  it("exposes the documented entrypoints of every package", () => {
    repo.write(
      "probe.mjs",
      [
        'import plugin from "@goodbones/oxlint";',
        'import { rules } from "@goodbones/oxlint/plugin";',
        'import { fingerprintOf, loadPolicy } from "@goodbones/core";',
        'import { makeFileSystemFake } from "@goodbones/core/testing";',
        'import { typescriptLanguage } from "@goodbones/typescript";',
        "process.stdout.write(JSON.stringify({",
        "  plugin: plugin.meta.name,",
        "  rules: Object.keys(plugin.rules).sort(),",
        "  same: plugin.rules === rules,",
        "  core: typeof fingerprintOf === 'function' && typeof loadPolicy === 'function',",
        "  testing: typeof makeFileSystemFake === 'function',",
        "  language: typescriptLanguage().id,",
        "}));",
        "",
      ].join("\n"),
    );
    const run = spawnSync(process.execPath, ["probe.mjs"], { cwd: repo.root, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      plugin: "architecture",
      rules: ["exports", "imports", "members", "structure", "surface"],
      same: true,
      core: true,
      testing: true,
      language: "typescript",
    });
  });
});
