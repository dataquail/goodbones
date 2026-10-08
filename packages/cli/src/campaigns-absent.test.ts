import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { decodeSnapshot } from "@goodbones/core";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { campaignsNotInstalled } from "./campaigns/none.js";
import { loadPolicyFromFile } from "./config-loader.js";
import {
  campaigns,
  check,
  type CheckReport,
  type CliFailure,
  conformance,
  explain,
  objectives,
} from "./run.js";

// The host as a user who never installed `@goodbones/campaigns` runs it: the
// policy composed with the family's `none`. Every command that is not a
// campaign command answers as it does with the family, with no campaigns in
// it; the two campaign commands, and a manifest using the family's keys,
// name the package to install.

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
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "campaigns-absent-")));
  write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "nodenext" } }));
  write("architecture.json", JSON.stringify(MANIFEST));
  write("src/a.ts", 'import { b } from "./b.js";\nexport const a = b;\n');
  write("src/b.ts", "export const b = 1;\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const load = () => loadPolicyFromFile(root, undefined, campaignsNotInstalled);

const capture = async (effect: Effect.Effect<void, CliFailure>) => {
  const lines: Array<string> = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const exit = await Effect.runPromiseExit(effect);
    return { exit, output: lines.join("") };
  } finally {
    process.stdout.write = original;
  }
};

const failureOf = (exit: Exit.Exit<void, CliFailure>): string => {
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  return Cause.pretty(exit.cause);
};

const manifestPath = () => path.join(root, "architecture.json");

describe.sequential("the CLI without @goodbones/campaigns", () => {
  it("checks clean, with no campaigns in the report", async () => {
    const { exit, output } = await capture(
      check(await load(), ["src"], { format: "json", manifestPath: manifestPath() }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const report = JSON.parse(output) as CheckReport;
    expect(report.ok).toBe(true);
    expect(report.files).toBe(2);
    expect(report.campaigns).toEqual([]);
  });

  it("measures conformance, with no campaigns in the snapshot", async () => {
    const { exit, output } = await capture(
      conformance(await load(), ["src"], { format: "json", manifestPath: manifestPath() }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const snapshot = decodeSnapshot(JSON.parse(output) as unknown);
    if (Result.isFailure(snapshot)) throw new Error(String(snapshot.failure));
    expect(snapshot.success.campaigns).toEqual([]);
  });

  it("explains a file, with no campaigns section", async () => {
    const { exit, output } = await capture(explain(await load(), "src/a.ts", ["src"]));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(output).toContain("src/a.ts");
    expect(output).not.toContain("campaigns:");
  });

  it("names the package to install for the campaign commands", async () => {
    const policy = await load();
    const status = await capture(campaigns(policy, ["src"], []));
    expect(failureOf(status.exit)).toContain(
      "`architecture campaigns` needs `@goodbones/campaigns`, which is not installed",
    );
    const clear = await capture(objectives(policy, ["src"], ["clear"]));
    expect(failureOf(clear.exit)).toContain(
      "`architecture objectives` needs `@goodbones/campaigns`, which is not installed",
    );
  });

  it("refuses a manifest that declares a campaign, naming the package", async () => {
    write(
      "with-campaigns.json",
      JSON.stringify({ ...MANIFEST, campaigns: {}, ledger: ".architecture-campaigns" }),
    );
    await expect(
      loadPolicyFromFile(root, "with-campaigns.json", campaignsNotInstalled),
    ).rejects.toThrow(
      /campaigns: belongs to a family that is not installed\. Install `@goodbones\/campaigns`/,
    );
  });
});
