import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadPolicyFromFile as loadPolicy } from "./config-loader.js";
import { check as checkWith, type CheckReport, type CliFailure, objectives } from "./run.js";

// The same call twice in one function, through the real matcher and a real
// ledger: two holdouts, and paying one down clears one. A `match` key is
// `file#anchor#hash`, and both calls share all three; the second is `~2`.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../.tmp-cli-repeats-tests");

const MANIFEST = JSON.stringify({
  resolve: {
    scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }],
    unresolved: "off",
  },
  campaigns: {
    fenced: {
      how: "Ask the access file.",
      scope: "src/**",
      objectives: {
        "no-role-checks": {
          holdout: "match",
          match: { syntax: { pattern: "$U.isSuperAdmin()" } },
          probes: { fires: [{ path: "src/a.ts", source: "user.isSuperAdmin()" }] },
        },
      },
    },
  },
  tree: { "src/": { layout: "open", children: {} } },
});

const write = (file: string, source: string): void => {
  const at = path.join(root, file);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, source);
};

const policyAt = (now: string) => {
  process.env.ARCHITECTURE_NOW = now;
  return loadPolicy(root);
};

const capture = async (effect: Effect.Effect<void, CliFailure>) => {
  const lines: Array<string> = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const exit = await Effect.runPromiseExit(effect);
    const failure = Exit.isFailure(exit)
      ? (Cause.squash(exit.cause) as { message?: string })
      : null;
    return { exit, output: lines.join(""), failure: failure?.message ?? "" };
  } finally {
    process.stdout.write = original;
  }
};

const check = async () => {
  const result = await capture(
    checkWith(await policyAt("2026-10-01T00:00:00Z"), ["src"], {
      format: "json",
      manifestPath: path.join(root, "architecture.json"),
    }),
  );
  return { ...result, report: JSON.parse(result.output) as CheckReport };
};

const clear = async (now: string) =>
  (await capture(objectives(await policyAt(now), ["src"], ["clear", "--by", "me"]))).output;

const holdouts = (): ReadonlyArray<string> =>
  (
    JSON.parse(
      readFileSync(path.join(root, ".architecture-campaigns/fenced/no-role-checks.json"), "utf8"),
    ) as { sectors: { scope: { holdouts: Array<string> } } }
  ).sectors.scope.holdouts;

const ROUTES = (checks: number): string =>
  [
    "export function authRoutes(user) {",
    ...Array.from({ length: checks }, () => "  if (user.isSuperAdmin()) audit();"),
    "  return [];",
    "}",
    "",
  ].join("\n");

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  write("architecture.json", MANIFEST);
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  write("src/routes.ts", ROUTES(2));
});

afterAll(() => {
  delete process.env.ARCHITECTURE_NOW;
  rmSync(root, { force: true, recursive: true });
});

describe.sequential("the same match twice in one declaration", () => {
  it("is two holdouts in the ledger", async () => {
    expect(await clear("2026-10-01T00:00:00Z")).toContain(
      "fenced/no-role-checks: 1 sector entered (scope); 2 holdouts left.",
    );
    const [first, second] = holdouts();
    expect(first).toMatch(/^src\/routes\.ts#authRoutes#[0-9a-f]{8}$/);
    expect(second).toBe(`${first ?? ""}~2`);
    expect(Exit.isSuccess((await check()).exit)).toBe(true);
  });

  it("clears one when one is paid down, and refuses a third", async () => {
    write("src/routes.ts", ROUTES(1));
    const paid = await check();
    expect(paid.report.campaigns[0]?.stale).toHaveLength(1);
    expect(await clear("2026-10-02T00:00:00Z")).toContain(
      "fenced/no-role-checks: 1 holdout cleared; 1 holdout left.",
    );
    expect(holdouts()).toHaveLength(1);

    // And the other way: a second identical call is growth, not a no-op.
    write("src/routes.ts", ROUTES(2));
    const grown = await check();
    expect(grown.report.campaigns[0]?.new).toHaveLength(1);
    expect(grown.failure).toContain("unrecorded campaign growth");
  });
});
