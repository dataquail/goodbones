import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
import { type Installed, installPacked, type Package, packAll, type Tarballs } from "../install.js";
import { oxlint } from "../oxlint.js";
import { createRepo, type Repo } from "../repo.js";

// The install of a user who never runs a campaign: the three hosts, the core
// and the pack, and neither optional peer — no `@goodbones/campaigns`, and
// no `@goodbones/ast-grep` with its native binary. Every host must load and
// answer for the other families, and whatever needs a missing peer must say
// which package to install.

const HOSTS: ReadonlyArray<Package> = ["core", "typescript", "cli", "oxlint", "browser"];

// The every-family manifest without its campaign: what this user writes.
const withoutCampaigns = (repo: Repo): Readonly<Record<string, unknown>> => {
  const { campaigns: _campaigns, ...rest } = everyFamilyManifest(repo.profile);
  return rest;
};

let packed: string;
let tarballs: Tarballs;
let repo: Repo;
let installed: Installed;

beforeAll(() => {
  packed = realpathSync(mkdtempSync(path.join(tmpdir(), "goodbones-pack-")));
  tarballs = packAll(packed);
  repo = createRepo({ files: everyFamilyFiles });
  repo.writeManifest(withoutCampaigns(repo));
  installed = installPacked(repo, tarballs, HOSTS);
});

afterAll(() => {
  repo.dispose();
  rmSync(packed, { force: true, recursive: true });
});

describe("an install without the optional peers", () => {
  it("has neither peer on disk, nor the matcher's native binary", () => {
    expect(repo.exists("node_modules/@goodbones/cli")).toBe(true);
    expect(repo.exists("node_modules/@goodbones/campaigns")).toBe(false);
    expect(repo.exists("node_modules/@goodbones/ast-grep")).toBe(false);
    expect(repo.exists("node_modules/@ast-grep")).toBe(false);
  });

  it("checks every other family through the installed bin, with no campaigns", () => {
    const result = check(repo, EVERY_FAMILY_ROOTS, { bin: installed.bin });
    expect(result.code, result.stderr).toBe(1);
    const { campaign: _campaign, ...rest } = everyFamilyFingerprints;
    expect(result.json.violations.map((one) => one.fingerprint).sort()).toEqual(
      [...Object.values(rest)].sort(),
    );
    expect(result.json.campaigns).toEqual([]);
  });

  it("names the package to install for a campaign command", () => {
    const result = cli(repo, ["campaigns"], { bin: installed.bin });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "`architecture campaigns` needs `@goodbones/campaigns`, which is not installed",
    );
  });

  it("lints every other family through the plugin by its package name, and says what the campaigns rule needs", () => {
    const linted = oxlint(repo, EVERY_FAMILY_ROOTS, { plugin: "@goodbones/oxlint" });
    expect(linted.loaded, linted.stdout + linted.stderr).toBe(true);
    const campaigns = linted.diagnostics.filter((one) => one.rule === "architecture/campaigns");
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]?.message).toContain(
      "architecture/campaigns needs `@goodbones/campaigns`, which is not installed",
    );
    expect(
      linted.diagnostics
        .filter((one) => one.rule !== "architecture/campaigns")
        .map((one) => `${one.rule} ${one.file}`)
        .sort(),
    ).toEqual(
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

  it("writes the browser's static export, with a campaign view that says the package is missing", () => {
    const bin = path.join(path.dirname(installed.bin), "goodbones-browser");
    const run = spawnSync(process.execPath, [bin, "build", "--out", "out", ...EVERY_FAMILY_ROOTS], {
      cwd: repo.root,
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const view = JSON.parse(readFileSync(repo.path("out/__goodbones/campaigns.json"), "utf8")) as {
      readonly installed: boolean;
      readonly campaigns: ReadonlyArray<unknown>;
    };
    expect(view.installed).toBe(false);
    expect(view.campaigns).toEqual([]);
  });

  it("refuses a manifest that declares a campaign, naming the package, in both hosts", () => {
    const campaigned = createRepo({ files: everyFamilyFiles });
    try {
      campaigned.writeManifest(everyFamilyManifest(campaigned.profile));
      const own = installPacked(campaigned, tarballs, HOSTS);
      const result = cli(campaigned, ["check", ...EVERY_FAMILY_ROOTS], { bin: own.bin });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(
        /campaigns: belongs to a family that is not installed\. Install `@goodbones\/campaigns`/,
      );
      const linted = oxlint(campaigned, EVERY_FAMILY_ROOTS, { plugin: "@goodbones/oxlint" });
      expect(linted.loaded).toBe(false);
      expect(linted.stdout + linted.stderr).toContain("@goodbones/campaigns");
    } finally {
      campaigned.dispose();
    }
  });

  it("refuses a `syntax` term with campaigns installed and no matcher, naming the matcher", () => {
    const syntactic = createRepo({ files: everyFamilyFiles });
    try {
      syntactic.writeManifest({
        resolve: { scopes: [syntactic.profile.scope] },
        campaigns: {
          "no-throw": {
            scope: ["src/**"],
            objectives: {
              throws: {
                holdout: "match",
                match: { syntax: { pattern: "throw new Error($$$)" } },
                probes: {
                  fires: [{ path: "src/a.ts", source: "function f() { throw new Error('x'); }" }],
                  ignores: [{ path: "src/b.ts", source: "function f() { return 1; }" }],
                },
              },
            },
          },
        },
        tree: { "src/": { layout: "open", children: {} } },
      });
      const own = installPacked(syntactic, tarballs, ["core", "typescript", "campaigns", "cli"]);
      expect(existsSync(syntactic.path("node_modules/@goodbones/ast-grep"))).toBe(false);
      const result = cli(syntactic, ["check", "src"], { bin: own.bin });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("carries no syntax matcher");
      expect(result.stderr).toContain("install `@goodbones/ast-grep`");
    } finally {
      syntactic.dispose();
    }
  });
});
