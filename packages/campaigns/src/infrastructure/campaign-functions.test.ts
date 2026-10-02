import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadCampaignFunctions } from "./campaign-functions.js";

// A campaign's `fn` module, loaded by a host that lives long: the browser's
// server reloads the policy on every change, and must get the function as
// it is now, not the one it imported the day it started.

const scratch = mkdtempSync(path.join(tmpdir(), "goodbones-campaign-fn-"));

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

describe("loadCampaignFunctions", () => {
  it("loads an edited module again on the next load", async () => {
    const manifestPath = path.join(scratch, "architecture.yaml");
    const module = path.join(scratch, "campaigns.mjs");
    const manifest = {
      campaigns: { one: { objectives: { lines: { measure: { fn: "campaigns.mjs#lines" } } } } },
    };
    const measured = async (): Promise<unknown> => {
      const { functions } = await loadCampaignFunctions(manifestPath, manifest);
      const lines = functions.get("campaigns.mjs#lines") as unknown as () => number;
      return lines();
    };

    writeFileSync(module, "export const lines = () => 627;\n");
    expect(await measured()).toBe(627);
    // Narrowed to `src/`, as a campaign's author would on finding it counted
    // the tests.
    writeFileSync(module, "export const lines = () => 409; // src only\n");
    expect(await measured()).toBe(409);
  });
});
