import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadPolicyFromFile as loadPolicy } from "./config-loader.js";
import {
  campaigns,
  check as checkWith,
  type CheckReport,
  type CliFailure,
  objectives,
} from "./run.js";

// The faults a seeded-fault experiment planted in a strangling, each of which
// the nudge or `check` once got wrong: a regression at the open last phase
// that passed, an attestation `clear` reported as going back, and one new
// import that had `check` advise clearing the record of the work still owed.
// One sector, walked up a ladder shaped like the experiment's.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../.tmp-cli-faults-tests");
const ledgerDir = path.join(root, ".architecture-campaigns", "strangle");

const MANIFEST = JSON.stringify({
  resolve: {
    scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }],
    unresolved: "off",
  },
  campaigns: {
    strangle: {
      why: "The old API is strangled, a module at a time.",
      how: "Move it behind the new server.",
      scope: "src/**",
      perimeter: { marker: "**/sector.ts" },
      // No campaign-wide `onTouch`: each defined phase ratchets by default,
      // and the open one advises.
      phases: [
        { id: "fenced", objectives: ["no-reach"] },
        { id: "mirrored", onTouch: "advise", objectives: ["writes-not-mirrored"] },
        { id: "backfilled", intent: "The rows were copied once.", attested: true },
        { id: "served", objectives: ["routes-local"] },
        { id: "moved", objectives: ["no-models"] },
        { id: "settled", intent: "What a settled module leaves behind is not written yet." },
      ],
      objectives: {
        "no-reach": {
          holdout: "match",
          match: { syntax: { pattern: "reach($$$)" } },
          probes: { fires: [{ path: "src/a.ts", source: "reach('x')" }] },
        },
        "writes-not-mirrored": {
          holdout: "match",
          match: { syntax: { pattern: "rawWrite($$$)" } },
          probes: { fires: [{ path: "src/a.ts", source: "rawWrite('x')" }] },
        },
        "routes-local": {
          holdout: "match",
          match: { syntax: { pattern: "localRoute($$$)" } },
          probes: { fires: [{ path: "src/a.ts", source: "localRoute('x')" }] },
        },
        "no-models": {
          holdout: "file",
          match: { content: { regex: "model\\(" } },
          probes: { fires: [{ path: "src/a.ts", source: "model('x')" }] },
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

// A fixture's git runs with the ambient repository's variables stripped: a
// hook's GIT_DIR wins over `cwd` (see campaigns.test.ts).
const AMBIENT_GIT = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_QUARANTINE_PATH",
];

const git = (...args: ReadonlyArray<string>): string =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !AMBIENT_GIT.includes(key)),
      ),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
    stdio: ["ignore", "pipe", "ignore"],
  });

const policyAt = (now = "2026-10-01T00:00:00Z") => {
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
    checkWith(await policyAt(), ["src"], {
      format: "json",
      manifestPath: path.join(root, "architecture.json"),
    }),
  );
  return { ...result, report: JSON.parse(result.output) as CheckReport };
};

const clear = async (now: string) => {
  const cleared = await capture(objectives(await policyAt(now), ["src"], ["clear"]));
  expect(Exit.isSuccess(cleared.exit), cleared.failure).toBe(true);
  return cleared.output;
};

const commit = (message: string): void => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
};

// Back to the last commit: the code and the ledgers both.
const reset = (): void => {
  git("reset", "-q", "--hard");
  git("clean", "-qfd");
};

type SectorLedger = { initial: number; cleared: number; closed: number; holdouts: Array<string> };
const sectorsOf = (objective: string): Record<string, SectorLedger> =>
  (
    JSON.parse(readFileSync(path.join(ledgerDir, `${objective}.json`), "utf8")) as {
      sectors: Record<string, SectorLedger>;
    }
  ).sectors;

type Sector = {
  sector: string;
  phase: { id: string | null };
  judged: { id: string | null };
  onTouch: string;
  ask: string;
  verdict: string;
  direction: string;
  added: Array<string>;
  held: Array<{ objective: string; phase: string | null; onTouch: string }>;
};

const nudge = async (...flags: ReadonlyArray<string>) => {
  const json = await capture(
    campaigns(await policyAt(), ["src"], ["status", "--changed", ...flags, "--json"]),
  );
  const text = await capture(
    campaigns(await policyAt(), ["src"], ["status", "--changed", ...flags]),
  );
  const parsed = JSON.parse(json.output) as { ok: boolean; sectors: Array<Sector> };
  const billing = parsed.sectors.find((one) => one.sector === "billing");
  if (billing === undefined) throw new Error("the diff did not touch the billing sector");
  return { exit: json.exit, ok: parsed.ok, billing, text: text.output };
};

const SERVICE = (body: ReadonlyArray<string>): string =>
  ["export function create(user) {", ...body, "}", ""].join("\n");

beforeAll(async () => {
  rmSync(root, { force: true, recursive: true });
  mkdirSync(root, { recursive: true });
  write("architecture.json", MANIFEST);
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  write("src/billing/sector.ts", 'export const sector = { name: "billing" };\n');
  write("src/billing/service.ts", SERVICE(['  localRoute("a");', '  return localRoute("b");']));
  write("src/billing/model.ts", 'export const subscription = model("subscriptions");\n');
  git("init", "-q");
  commit("fixture");
  // Fenced and mirrored hold nothing: billing waits at backfilled for a hand.
  await clear("2026-10-01T00:00:00Z");
  commit("first clear");
});

afterAll(() => {
  delete process.env.ARCHITECTURE_NOW;
  rmSync(root, { force: true, recursive: true });
});

describe.sequential("the faults a strangling plants", () => {
  it("reports the clear after an attestation as the move forward it records (C2)", async () => {
    const attested = await capture(
      campaigns(
        await policyAt("2026-10-02T00:00:00Z"),
        ["src"],
        ["attest", "billing", "backfilled", "--reason", "backfill ran", "--by", "me"],
      ),
    );
    expect(Exit.isSuccess(attested.exit), attested.failure).toBe(true);
    // Served has no ledger for billing yet: it was never entered, and is not
    // read as met past the phase billing has reached.
    const output = await clear("2026-10-02T00:00:00Z");
    expect(output).toContain("strangle: billing moved backfilled → served");
    expect(output).not.toContain("went back");
    expect(sectorsOf("routes-local").billing?.holdouts).toHaveLength(2);
    commit("attested");
  });

  it("holds the entries a regression put behind their window, rather than calling them stale (R3)", async () => {
    // One import of a peer: billing falls from served to fenced.
    write(
      "src/billing/service.ts",
      SERVICE(['  reach("organization");', '  localRoute("a");', '  return localRoute("b");']),
    );
    const { exit, failure, report } = await check();
    expect(Exit.isFailure(exit)).toBe(true);
    const campaign = report.campaigns[0];
    expect(campaign?.new.map((one) => `${one.objective}/${one.sector}`)).toEqual([
      "no-reach/billing",
    ]);
    // Not stale: served's holdouts are still owed, and `clear` must not be
    // advised to close them.
    expect(campaign?.stale).toEqual([]);
    expect(failure).not.toContain("stale ledger entries");

    // A `clear` on that tree leaves them as they were.
    const before = sectorsOf("routes-local").billing;
    await clear("2026-10-03T00:00:00Z");
    expect(sectorsOf("routes-local").billing).toEqual(before);
    reset();
  });

  it("refuses a regression at the open last phase, held by the phase that named it (R1)", async () => {
    // Served paid down, then the model deleted: billing settles.
    write("src/billing/service.ts", SERVICE(["  return proxy();"]));
    await clear("2026-10-04T00:00:00Z");
    commit("served");
    unlinkSync(path.join(root, "src/billing/model.ts"));
    await clear("2026-10-05T00:00:00Z");
    commit("moved");

    // The model comes back, as if its deletion had been forgotten.
    write("src/billing/model.ts", 'export const subscription = model("subscriptions");\n');
    for (const flags of [[], ["--base", "HEAD"]]) {
      const { billing, exit, ok, text } = await nudge(...flags);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(ok).toBe(false);
      expect(billing).toMatchObject({
        phase: { id: "moved" },
        judged: { id: "settled" },
        // The open phase's own word, and what it asks, are unchanged.
        onTouch: "advise",
        ask: "note",
        verdict: "back",
        held: [{ objective: "no-models", phase: "moved", onTouch: "ratchet" }],
      });
      expect(text).toContain(
        "went back at an open phase, held by the phase that named it: no-models (moved, ratchet)",
      );
      expect(text.trimEnd().endsWith("not ok")).toBe(true);
    }
    reset();
  });
});
