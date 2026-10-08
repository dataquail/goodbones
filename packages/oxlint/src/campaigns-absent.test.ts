import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { RuleTester } from "oxlint/plugins-dev";
import { afterAll, describe, expect, it } from "vitest";

import { campaignsNotInstalled, notInstalledRule } from "./campaigns/none.js";
import { loadPolicyFromFile } from "./config-loader.js";

// The plugin as a user who never installed `@goodbones/campaigns` loads it:
// the policy composed with the family's `none`. The other rules are what
// they always were; a manifest using the family's keys names the package;
// and the `campaigns` rule, which a configuration may still turn on, says
// once what to install rather than leave oxlint to call it unknown.

RuleTester.describe = describe.sequential;
RuleTester.it = it.sequential;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// Inside the package, as config-loader.test.ts explains: Vitest resolves the
// loader's dynamic import of an `.mjs` manifest through its own module graph.
const scratch = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.tmp-absent-tests");
mkdirSync(scratch, { recursive: true });

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

const writeConfig = (name: string, value: unknown): string => {
  writeFileSync(path.join(scratch, name), JSON.stringify(value));
  return path.join(scratch, name);
};

const MANIFEST = {
  resolve: {
    scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.resolve.json" } }],
  },
  tree: {
    "packages/core/src/": {
      message: "The core.",
      imports: { message: "The core reaches itself.", allow: ["packages/core/src/**"] },
      children: { "*.ts": {} },
    },
  },
};

describe.sequential("the plugin without @goodbones/campaigns", () => {
  it.sequential("loads a manifest with no campaigns", async () => {
    const policy = await loadPolicyFromFile(
      repoRoot,
      writeConfig("plain.json", MANIFEST),
      campaignsNotInstalled,
    );
    expect(policy.importRules.map((rule) => rule.name)).toEqual(["packages-core-src/imports"]);
  });

  it.sequential("refuses a manifest that declares a campaign, naming the package", async () => {
    await expect(
      loadPolicyFromFile(
        repoRoot,
        writeConfig("with-campaigns.json", { ...MANIFEST, campaigns: {} }),
        campaignsNotInstalled,
      ),
    ).rejects.toThrow(
      /campaigns: belongs to a family that is not installed\. Install `@goodbones\/campaigns`/,
    );
  });
});

// One rule instance across both files, as one oxlint process holds one.
const rule = notInstalledRule();

new RuleTester({ cwd: repoRoot }).run("campaigns, not installed", rule, {
  valid: [],
  invalid: [
    {
      code: "export const a = 1;",
      filename: path.join(repoRoot, "packages/core/src/first.ts"),
      errors: [
        {
          message:
            "architecture/campaigns needs `@goodbones/campaigns`, which is not installed. Install it beside @goodbones/oxlint, or turn the rule off.",
        },
      ],
    },
  ],
});

new RuleTester({ cwd: repoRoot }).run("campaigns, not installed, on the next file", rule, {
  valid: [{ code: "export const b = 2;", filename: path.join(repoRoot, "packages/core/src/b.ts") }],
  invalid: [],
});
