import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { campaignsNotInstalled } from "./campaigns/none.js";
import { collect } from "./collect.js";

// The browser as a user who never installed `@goodbones/campaigns` runs it:
// the Architecture Browser drawn as ever, and a campaign view that says the
// package is missing rather than that the policy declares no campaigns.

let root: string;

const MANIFEST = {
  resolve: {
    scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }],
    unresolved: "off",
  },
  tree: {
    "src/": {
      message: "src/ reaches only itself.",
      imports: { message: "src/ may reach only itself.", allow: ["src/**"] },
      children: { "*.ts": {} },
    },
  },
};

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "browser-absent-")));
  write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "nodenext" } }));
  write("architecture.json", JSON.stringify(MANIFEST));
  write("with-campaigns.json", JSON.stringify({ ...MANIFEST, campaigns: {} }));
  write("src/a.ts", 'import { b } from "./b.js";\nexport const a = b;\n');
  write("src/b.ts", "export const b = 1;\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the browser without @goodbones/campaigns", () => {
  it("draws the architecture, and a campaign view that says the package is missing", async () => {
    const collected = await collect({
      repoRoot: root,
      roots: ["src"],
      nudge: false,
      campaigns: campaignsNotInstalled,
    });
    expect(collected.atlas.files.map((file) => file.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(collected.campaigns.installed).toBe(false);
    expect(collected.campaigns.campaigns).toEqual([]);
  });

  it("refuses a manifest that declares a campaign, naming the package", async () => {
    await expect(
      collect({
        repoRoot: root,
        roots: ["src"],
        configFilename: "with-campaigns.json",
        nudge: false,
        campaigns: campaignsNotInstalled,
      }),
    ).rejects.toThrow(
      /campaigns: belongs to a family that is not installed\. Install `@goodbones\/campaigns`/,
    );
  });

  it("draws an installed family's view when the package is there", async () => {
    const collected = await collect({ repoRoot: root, roots: ["src"], nudge: false });
    expect(collected.campaigns.installed).toBe(true);
    expect(collected.campaigns.campaigns).toEqual([]);
  });
});
