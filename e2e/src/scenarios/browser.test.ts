import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EVERY_FAMILY_ROOTS,
  everyFamilyFiles,
  everyFamilyManifest,
} from "../fixtures/every-family.js";
import { type Installed, installPacked, packAll, type Tarballs } from "../install.js";
import { createRepo, type Repo } from "../repo.js";

// The browser as npm ships it: installed into the fixture beside the CLI, its
// bin resolves, and `build --out` writes the page with both models beside it
// — the atlas naming the fixture's files and edges, the campaign the fixture
// declares.

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

type AtlasJson = {
  readonly version: number;
  readonly name: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly walked: boolean }>;
  readonly edges: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly status: string;
  }>;
  readonly manifest: { readonly nodes: ReadonlyArray<{ readonly id: string }> };
};

describe("browser", () => {
  it("ships the page, and writes a static export over the fixture through the installed bin", () => {
    const site = path.join(installed.packages.browser ?? "", "build", "site", "index.html");
    expect(existsSync(site)).toBe(true);

    const bin = path.join(path.dirname(installed.bin), "goodbones-browser");
    expect(existsSync(bin)).toBe(true);
    const run = spawnSync(process.execPath, [bin, "build", "--out", "out", ...EVERY_FAMILY_ROOTS], {
      cwd: repo.root,
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("wrote out:");

    expect(repo.exists("out/index.html")).toBe(true);
    const atlas = JSON.parse(
      readFileSync(repo.path("out/__goodbones/atlas.json"), "utf8"),
    ) as AtlasJson;
    expect(atlas.version).toBe(1);
    expect(atlas.name).toBe(path.basename(repo.root));
    expect(atlas.files.length).toBeGreaterThan(0);
    expect(atlas.files.every((file) => file.walked)).toBe(true);
    expect(atlas.edges.length).toBeGreaterThan(0);
    expect(atlas.manifest.nodes.length).toBeGreaterThan(0);

    const campaigns = JSON.parse(
      readFileSync(repo.path("out/__goodbones/campaigns.json"), "utf8"),
    ) as {
      campaigns: ReadonlyArray<{ readonly id: string; readonly sectors: ReadonlyArray<unknown> }>;
      nudge: unknown;
    };
    expect(campaigns.campaigns.map((one) => one.id)).toEqual(["legacy-to-modern"]);
    expect(campaigns.campaigns[0]?.sectors.length).toBeGreaterThan(0);
    // A static export runs no git: the nudge is the served page's alone.
    expect(campaigns.nudge).toBeNull();

    const status = JSON.parse(readFileSync(repo.path("out/__goodbones/status.json"), "utf8")) as {
      live: boolean;
    };
    expect(status.live).toBe(false);
  });
});
