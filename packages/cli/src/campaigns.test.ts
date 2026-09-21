import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadPolicyFromFile as loadPolicy } from "./config-loader.js";
import { parseDiff } from "./diff.js";
import {
  campaigns,
  check as checkWith,
  type CheckReport,
  type CliFailure,
  conformance,
  explain,
  objectives,
} from "./run.js";

// A repository running the design's billing campaign: bounded contexts born
// by a `context.ts` marker, a ladder from `domain` to an open `aggregates`,
// a windowed presence, an attested step. Driven through clear, the
// derived phases, attest, note, a plan change with and without its receipt,
// and the nudge over a real git diff — the thing the rest exists to serve.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../.tmp-cli-phases-tests");

// Written as JSON, since a module manifest is cached by the loader for the
// life of the process and this suite edits the plan.
const MANIFEST = (
  repositoryObjectives: ReadonlyArray<string>,
  concessions: ReadonlyArray<{ reason: string; at: string }> = [],
): string =>
  JSON.stringify({
    resolve: {
      scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }],
      unresolved: "off",
    },
    campaigns: {
      "billing-ddd": {
        why: "The billing mud becomes bounded contexts.",
        how: "Move the call behind the port.",
        scope: "src/**",
        perimeter: { marker: "**/context.ts" },
        staleAfter: "30d",
        phases: [
          { id: "domain", intent: "no I/O in the domain", objectives: ["no-io"] },
          {
            id: "repository",
            objectives: repositoryObjectives,
            ...(concessions.length === 0 ? {} : { concessions }),
          },
          { id: "dual-write", intent: "the flag writes both ways", objectives: ["has-flag"] },
          { id: "backfilled", intent: "rows copied", attested: true },
          { id: "cutover", objectives: ["no-flag"] },
          {
            id: "aggregates",
            intent: "Model refunds inside billing, or split them out — undecided.",
          },
        ],
        objectives: {
          "no-io": {
            holdout: "match",
            match: { syntax: { pattern: "readFileSync($$$)" } },
            probes: { fires: [{ path: "src/a.ts", source: "readFileSync('x')" }] },
          },
          "no-knex": {
            holdout: "match",
            match: { syntax: { pattern: "knex($$$)" } },
            probes: { fires: [{ path: "src/a.ts", source: "knex('x')" }] },
          },
          "no-console": {
            holdout: "match",
            match: { syntax: { pattern: "console.log($$$)" } },
            probes: { fires: [{ path: "src/a.ts", source: "console.log('x')" }] },
          },
          "has-migration": {
            holdout: "sector",
            sector: { has: { path: { file: "/migrations/" } } },
          },
          "has-flag": {
            holdout: "sector",
            until: "cutover",
            sector: { has: { content: { regex: "flags\\.dualWrite" } } },
            probes: { fires: [{ path: "src/a.ts", source: "flags.dualWrite" }] },
          },
          "no-flag": {
            holdout: "file",
            match: { content: { regex: "flags\\.dualWrite" } },
            probes: { fires: [{ path: "src/a.ts", source: "flags.dualWrite" }] },
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

const git = (...args: ReadonlyArray<string>): string =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
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

const check = async (now?: string) => {
  const result = await capture(
    checkWith(await policyAt(now), ["src"], {
      format: "json",
      manifestPath: path.join(root, "architecture.json"),
    }),
  );
  return { ...result, report: JSON.parse(result.output) as CheckReport };
};

const ledgerDir = path.join(root, ".architecture-campaigns", "billing-ddd");
const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(ledgerDir, file), "utf8")) as Record<string, unknown>;
type SectorLedger = { initial: number; cleared: number; closed: number; holdouts: Array<string> };
const sectorsOf = (objective: string): Record<string, SectorLedger> =>
  readJson(`${objective}.json`).sectors as Record<string, SectorLedger>;

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  write("architecture.json", MANIFEST(["no-knex", "has-migration"]));
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  write("src/billing/context.ts", 'export const sector = { name: "billing" };\n');
  write(
    "src/billing/service.ts",
    [
      "export function reconcile() {",
      "  const text = readFileSync('x');",
      "  return knex(text);",
      "}",
      "export function voidIt() {",
      "  return knex('void');",
      "}",
      "",
    ].join("\n"),
  );
  write("src/orders/context.ts", "");
  write("src/orders/service.ts", "export const place = () => 1;\n");
  write("src/orders/migrations/001.ts", "export const up = () => 1;\n");
  write("src/services/legacy.ts", "export const old = () => readFileSync('y');\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
});

afterAll(() => {
  delete process.env.ARCHITECTURE_NOW;
  rmSync(root, { force: true, recursive: true });
});

describe.sequential("a campaign with sectors and phases", () => {
  it("births sectors from the markers, derives each one's phase, and asks for a clear", async () => {
    const { exit, report } = await check();
    expect(Exit.isFailure(exit)).toBe(true);
    const [campaign] = report.campaigns;
    expect(campaign?.missingLedger).toBe(true);
    expect(campaign?.sectors).toEqual([
      // billing has I/O: domain. orders is clean up to the flag it lacks:
      // dual-write. The legacy stands at the first phase.
      // `no-console` is named by no phase yet, so it is in window everywhere.
      {
        name: "billing",
        phase: "domain",
        reached: null,
        files: 2,
        residue: { "no-io": 1, "no-console": 0 },
      },
      {
        name: "orders",
        phase: "dual-write",
        reached: null,
        files: 3,
        residue: { "no-io": 0, "no-knex": 0, "no-console": 0, "has-migration": 0, "has-flag": 1 },
      },
      {
        name: "legacy",
        phase: "domain",
        reached: null,
        files: 1,
        residue: { "no-io": 1, "no-console": 0 },
      },
    ]);
    // Only the hits in window are violations: billing's knex calls are not
    // yet, since billing has not reached `repository`.
    const hits = report.violations.filter((one) => one.kind === "campaign");
    expect(
      hits.map((one) => `${one.sector ?? ""}/${one.objective ?? ""}/${one.entry ?? ""}`),
    ).toEqual([
      // Anchored on the nearest declaration: the `text` the call initializes.
      expect.stringMatching(/^billing\/no-io\/service\.ts#text#[0-9a-f]{8}$/),
      expect.stringMatching(/^legacy\/no-io\/src\/services\/legacy\.ts#old#[0-9a-f]{8}$/),
      "orders/has-flag/~",
    ]);
  });

  it("clear records each sector's initial per objective in window, its reached phase, and the plan", async () => {
    const cleared = await capture(objectives(await policyAt(), ["src"], ["clear"]));
    expect(Exit.isSuccess(cleared.exit), cleared.failure).toBe(true);
    expect(cleared.output).toContain(
      "billing-ddd/no-io: 3 sectors entered (billing, orders, legacy); 2 holdouts left.",
    );
    expect(cleared.output).toContain(
      "billing-ddd/no-knex: 1 sector entered (orders); 0 holdouts left.",
    );
    expect(cleared.output).toContain(
      "billing-ddd/has-flag: 1 sector entered (orders); 1 holdout left.",
    );
    expect(sectorsOf("no-io").billing).toMatchObject({ initial: 1 });
    expect(sectorsOf("no-knex").billing).toBeUndefined();
    expect(sectorsOf("has-flag").orders?.holdouts).toEqual(["~"]);
    expect(readJson("sectors/billing.json")).toMatchObject({ reached: "domain" });
    expect(readJson("sectors/orders.json")).toMatchObject({ reached: "dual-write" });
    expect(existsSync(path.join(ledgerDir, "sectors/legacy.json"))).toBe(false);
    expect(
      (readJson("plan.json").phases as Array<{ id: string; defined: boolean }>).map((one) => [
        one.id,
        one.defined,
      ]),
    ).toEqual([
      ["domain", true],
      ["repository", true],
      ["dual-write", true],
      ["backfilled", true],
      ["cutover", true],
      ["aggregates", false],
    ]);
    const { exit } = await check();
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("prints the phase distribution in the status table and the snapshot", async () => {
    const status = await capture(campaigns(await policyAt(), ["src"], []));
    expect(status.output).toContain(
      "phases: domain 1 → repository 0 → dual-write 1 → backfilled 0 → cutover 0 → aggregates (open) 0  · legacy 1 file",
    );
    const snapshot = await capture(
      conformance(await policyAt(), ["src"], {
        format: "json",
        manifestPath: path.join(root, "architecture.json"),
      }),
    );
    const parsed = JSON.parse(snapshot.output) as {
      campaigns: Array<{
        phases: unknown;
        legacy: unknown;
        objectives: Array<{ id: string; phase: string | null }>;
      }>;
    };
    expect(parsed.campaigns[0]?.phases).toEqual([
      { id: "domain", defined: true, sectors: 1 },
      { id: "repository", defined: true, sectors: 0 },
      { id: "dual-write", defined: true, sectors: 1 },
      { id: "backfilled", defined: true, sectors: 0 },
      { id: "cutover", defined: true, sectors: 0 },
      { id: "aggregates", defined: false, sectors: 0 },
    ]);
    expect(parsed.campaigns[0]?.legacy).toEqual({ files: 1, holdouts: 1 });
    expect(parsed.campaigns[0]?.objectives.map((one) => [one.id, one.phase])).toEqual([
      ["no-io", "domain"],
      ["no-knex", "repository"],
      ["no-console", null],
      ["has-migration", "repository"],
      ["has-flag", "dual-write"],
      ["no-flag", "cutover"],
    ]);
  });

  it("moves a sector on when its phase's objectives reach zero, and the next phase's window opens", async () => {
    write(
      "src/billing/service.ts",
      [
        "export function reconcile() {",
        "  return knex('text');",
        "}",
        "export function voidIt() {",
        "  return knex('void');",
        "}",
        "",
      ].join("\n"),
    );
    const before = await check();
    expect(Exit.isFailure(before.exit)).toBe(true);
    // The fix is stale in `no-io`; and billing, now at `repository`, has
    // two knex calls and no migration in a window no ledger has seen.
    expect(
      before.report.campaigns[0]?.stale.map((one) => `${one.objective}/${one.sector}`),
    ).toEqual(["no-io/billing"]);
    expect(before.report.campaigns[0]?.missingLedger).toBe(true);
    expect(before.report.campaigns[0]?.sectors.find((one) => one.name === "billing")).toMatchObject(
      {
        phase: "repository",
        residue: { "no-io": 0, "no-knex": 2, "no-console": 0, "has-migration": 1 },
      },
    );
    const cleared = await capture(
      objectives(await policyAt("2026-10-02T00:00:00Z"), ["src"], ["clear"]),
    );
    expect(cleared.output).toContain("billing-ddd/no-io: 1 holdout cleared; 1 holdout left.");
    expect(cleared.output).toContain(
      "billing-ddd/no-knex: 1 sector entered (billing); 2 holdouts left.",
    );
    expect(readJson("sectors/billing.json")).toMatchObject({
      reached: "repository",
      since: "2026-10-02T00:00:00.000Z",
    });
    expect(Exit.isSuccess((await check()).exit)).toBe(true);
  });

  it("explains a file: its sector, phase, the objectives in window, and the nearest holdouts", async () => {
    const explained = await capture(explain(await policyAt(), "src/billing/service.ts", ["src"]));
    expect(explained.output).toContain(
      "campaign/billing-ddd: sector billing — phase repository (2 of 6), reached repository",
    );
    expect(explained.output).toContain("in window: no-io, no-knex ✗, no-console, has-migration");
    expect(explained.output).toMatch(/:2 {2}no-knex {2}reconcile#[0-9a-f]{8}/);
  });

  it("attests a step no detector sees, only at that phase, and the sector moves on at the next clear", async () => {
    // orders at dual-write: writing the flag satisfies the presence.
    write("src/orders/service.ts", "export const place = () => flags.dualWrite ? 2 : 1;\n");
    await capture(objectives(await policyAt("2026-10-03T00:00:00Z"), ["src"], ["clear"]));
    expect(sectorsOf("has-flag").orders).toMatchObject({ cleared: 1, holdouts: [] });
    expect(readJson("sectors/orders.json")).toMatchObject({ reached: "backfilled" });

    const early = await capture(
      campaigns(
        await policyAt(),
        ["src"],
        ["attest", "billing", "backfilled", "--reason", "done", "--by", "me"],
      ),
    );
    expect(Exit.isFailure(early.exit)).toBe(true);
    expect(early.failure).toContain("stands at repository, not backfilled");

    const attested = await capture(
      campaigns(
        await policyAt("2026-10-04T00:00:00Z"),
        ["src"],
        [
          "attest",
          "orders",
          "backfilled",
          "--reason",
          "backfill ran",
          "--evidence",
          "https://ci/run/1",
          "--by",
          "me",
        ],
      ),
    );
    expect(Exit.isSuccess(attested.exit), attested.failure).toBe(true);
    expect(readJson("sectors/orders.json")).toMatchObject({
      attested: [
        {
          phase: "backfilled",
          reason: "backfill ran",
          evidence: "https://ci/run/1",
          at: "2026-10-04T00:00:00.000Z",
          by: "me",
        },
      ],
    });
    // Past backfilled, at cutover, the flag is now a holdout — and
    // `has-flag`'s window is shut for orders for good.
    const after = await check();
    expect(after.report.campaigns[0]?.sectors.find((one) => one.name === "orders")).toMatchObject({
      phase: "cutover",
      residue: { "no-io": 0, "no-knex": 0, "no-console": 0, "has-migration": 0, "no-flag": 1 },
    });
    await capture(objectives(await policyAt("2026-10-05T00:00:00Z"), ["src"], ["clear"]));
    expect(sectorsOf("no-flag").orders?.holdouts).toEqual(["service.ts"]);
  });

  it("reaches the open phase, where a note is what the nudge collects", async () => {
    write("src/orders/service.ts", "export const place = () => 2;\n");
    await capture(objectives(await policyAt("2026-10-06T00:00:00Z"), ["src"], ["clear"]));
    expect(readJson("sectors/orders.json")).toMatchObject({ reached: "aggregates" });
    const noted = await capture(
      campaigns(
        await policyAt("2026-10-07T00:00:00Z"),
        ["src"],
        ["note", "orders", "refunds read invoices but never write them", "--by", "me"],
      ),
    );
    expect(Exit.isSuccess(noted.exit), noted.failure).toBe(true);
    expect(readJson("sectors/orders.json")).toMatchObject({
      notes: [
        { phase: "aggregates", text: "refunds read invoices but never write them", by: "me" },
      ],
    });
  });

  it("nudges a diff that sends a sector back under ratchet, and lets a hotfix through with a concession", async () => {
    git("add", "-A");
    git("commit", "-q", "-m", "progress");
    write(
      "src/billing/service.ts",
      [
        "export function reconcile() {",
        "  return knex('text');",
        "}",
        "export function voidIt() {",
        "  return knex('void');",
        "}",
        "export function refund() {",
        "  return knex('refund');",
        "}",
        "",
      ].join("\n"),
    );
    const nudged = await capture(
      campaigns(await policyAt(), ["src"], ["status", "--changed", "--json"]),
    );
    expect(Exit.isFailure(nudged.exit)).toBe(true);
    const nudge = JSON.parse(nudged.output) as {
      mode: string;
      ok: boolean;
      sectors: Array<
        Record<string, unknown> & {
          holdouts: {
            total: number;
            shown: Array<{ line: number | null; subject: string | null }>;
          };
        }
      >;
    };
    expect(nudge.mode).toBe("ledger");
    expect(nudge.ok).toBe(false);
    expect(nudge.sectors).toHaveLength(1);
    expect(nudge.sectors[0]).toMatchObject({
      campaign: "billing-ddd",
      sector: "billing",
      phase: { id: "repository", index: 1, of: 6, open: false },
      onTouch: "ratchet",
      ask: "hold",
      verdict: "back",
      direction: "back",
      residue: {
        before: { "no-io": 0, "no-knex": 2, "no-console": 0, "has-migration": 1 },
        after: { "no-io": 0, "no-knex": 3, "no-console": 0, "has-migration": 1 },
      },
      toward: { "no-knex": 3, "has-migration": 1 },
    });
    // Nearest the change first: the new call, then the two above it, then
    // the sector's own holdout.
    expect(nudge.sectors[0]?.holdouts.total).toBe(4);
    expect(
      nudge.sectors[0]?.holdouts.shown.map((one) => one.subject?.split("#")[0] ?? "~"),
    ).toEqual(["refund", "voidIt", "reconcile", "~"]);
    const text = await capture(campaigns(await policyAt(), ["src"], ["status", "--changed"]));
    expect(text.output).toContain("billing — phase repository (2 of 6)");
    expect(text.output).toContain("toward the next phase: no-knex 3 · has-migration 1");
    expect(text.output).toContain("onTouch: ratchet — back");
    expect(text.output).toContain("ask: hold");

    const escaped = await capture(
      campaigns(
        await policyAt("2026-10-08T00:00:00Z"),
        ["src"],
        ["status", "--changed", "--hotfix", "BILL-412", "--by", "me"],
      ),
    );
    expect(Exit.isSuccess(escaped.exit), escaped.failure).toBe(true);
    expect(escaped.output).toContain("onTouch: ratchet — hotfix");
    expect(readJson("no-knex.json").concessions).toEqual([
      expect.objectContaining({
        sector: "billing",
        delta: 1,
        reason: "hotfix: BILL-412",
        by: "me",
      }),
    ]);
    expect(Exit.isSuccess((await check()).exit)).toBe(true);
  });

  it("nudges a touch in an open phase with the intent and the notes, as data", async () => {
    git("add", "-A");
    git("commit", "-q", "-m", "hotfix");
    write("src/orders/service.ts", "export const place = () => 3;\n");
    const nudged = await capture(
      campaigns(await policyAt(), ["src"], ["status", "--changed", "--json"]),
    );
    expect(Exit.isSuccess(nudged.exit), nudged.failure).toBe(true);
    const nudge = JSON.parse(nudged.output) as { sectors: Array<Record<string, unknown>> };
    expect(nudge.sectors[0]).toMatchObject({
      sector: "orders",
      phase: { id: "aggregates", open: true },
      intent: "Model refunds inside billing, or split them out — undecided.",
      notes: [{ by: "me", text: "refunds read invoices but never write them" }],
      onTouch: "advise",
      ask: "note",
      verdict: "ok",
    });
    const text = await capture(campaigns(await policyAt(), ["src"], ["status", "--changed"]));
    expect(text.output).toContain("intent: Model refunds inside billing");
    expect(text.output).toContain("architecture campaigns note orders");
    // A diff touching nothing under the campaign says so in one line.
    git("checkout", "-q", "--", "src/orders/service.ts");
    write("README.md", "hello\n");
    const quiet = await capture(campaigns(await policyAt(), ["src"], ["status", "--changed"]));
    expect(quiet.output).toContain("nothing you touched is under a campaign");
    rmSync(path.join(root, "README.md"));
  });

  it("evaluates the base tree in the exact mode, and names an un-birth", async () => {
    write(
      "src/billing/service.ts",
      ["export function reconcile() {", "  return knex('text');", "}", ""].join("\n"),
    );
    rmSync(path.join(root, "src/orders/context.ts"));
    const nudged = await capture(
      campaigns(await policyAt(), ["src"], ["status", "--changed", "--base", "HEAD", "--json"]),
    );
    expect(Exit.isSuccess(nudged.exit), nudged.failure).toBe(true);
    const nudge = JSON.parse(nudged.output) as {
      mode: string;
      unbirths: unknown;
      sectors: Array<Record<string, unknown>>;
    };
    expect(nudge.mode).toBe("exact");
    expect(nudge.unbirths).toEqual([
      { campaign: "billing-ddd", sector: "orders", marker: "src/orders/context.ts" },
    ]);
    expect(nudge.sectors.find((one) => one.sector === "billing")).toMatchObject({
      direction: "forward",
      verdict: "ok",
      residue: { before: { "no-knex": 3 }, after: { "no-knex": 1 } },
    });
    git("checkout", "-q", "--", "src");
  });

  it("refuses a change to a defined phase without a concession, and re-baselines with one", async () => {
    write("architecture.json", MANIFEST(["no-knex", "no-console", "has-migration"]));
    write(
      "src/billing/service.ts",
      readFileSync(path.join(root, "src/billing/service.ts"), "utf8") + "console.log('x');\n",
    );
    const refused = await check();
    expect(Exit.isFailure(refused.exit)).toBe(true);
    expect(refused.report.campaigns[0]?.plan).toEqual({
      refined: [],
      changed: ["repository"],
      unreceipted: ["repository"],
    });
    expect(refused.failure).toContain("changed without a concession");

    write(
      "architecture.json",
      MANIFEST(
        ["no-knex", "no-console", "has-migration"],
        [{ reason: "console noise blocks the port", at: "2026-10-09" }],
      ),
    );
    const receipted = await check();
    expect(receipted.report.campaigns[0]?.plan).toEqual({
      refined: [],
      changed: ["repository"],
      unreceipted: [],
    });
    expect(receipted.failure).not.toContain("concession");
    const cleared = await capture(
      objectives(await policyAt("2026-10-09T00:00:00Z"), ["src"], ["clear"]),
    );
    expect(cleared.output).toContain("billing-ddd/no-console: 1 sector re-baselined (billing)");
    expect(readJson("no-console.json").concessions).toEqual([
      expect.objectContaining({
        sector: "billing",
        from: 0,
        to: 1,
        reason: "phase repository changed: console noise blocks the port",
      }),
    ]);
    const after = await check();
    expect(after.report.campaigns[0]?.plan).toEqual({ refined: [], changed: [], unreceipted: [] });
    expect(Exit.isSuccess(after.exit), after.failure).toBe(true);
  });

  it("replays the ledgers' history from git", async () => {
    git("add", "-A");
    git("commit", "-q", "-m", "plan change");
    const history = await capture(campaigns(await policyAt(), ["src"], ["history", "--json"]));
    expect(Exit.isSuccess(history.exit), history.failure).toBe(true);
    const parsed = JSON.parse(history.output) as {
      rows: Array<{ counts: Record<string, number>; planChanged: boolean }>;
    };
    expect(parsed.rows.length).toBeGreaterThanOrEqual(3);
    expect(parsed.rows.at(-1)).toMatchObject({
      counts: { "no-knex": 3, "no-console": 1 },
      planChanged: true,
    });
    const text = await capture(campaigns(await policyAt(), ["src"], ["history"]));
    expect(text.output).toContain("billing-ddd:");
  });
});

describe("the diff reader", () => {
  it("parses -U0 output into hunks, additions and deletions", () => {
    const parsed = parseDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -3,0 +4,2 @@",
        "+x",
        "+y",
        "@@ -10 +12 @@",
        "-z",
        "+w",
        "diff --git a/src/new.ts b/src/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/new.ts",
        "@@ -0,0 +1,3 @@",
        "diff --git a/src/gone.ts b/src/gone.ts",
        "deleted file mode 100644",
        "--- a/src/gone.ts",
        "+++ /dev/null",
        "@@ -1,3 +0,0 @@",
        "diff --git a/src/empty.ts b/src/empty.ts",
        "deleted file mode 100644",
      ].join("\n"),
    );
    expect([...parsed.touched.entries()]).toEqual([
      [
        "src/a.ts",
        [
          { start: 4, end: 5 },
          { start: 12, end: 12 },
        ],
      ],
      ["src/new.ts", [{ start: 1, end: 3 }]],
    ]);
    expect(parsed.added).toEqual(["src/new.ts"]);
    expect(parsed.deleted).toEqual(["src/empty.ts", "src/gone.ts"]);
  });
});

// An end state: a sector-relative tree expanded into one objective per
// family, lowered per sector and evaluated over its files.
const endRoot = path.resolve(here, "../../../.tmp-cli-end-state-tests");

const END_MANIFEST = `export default {
  resolve: { scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }], unresolved: "off" },
  campaigns: {
    onion: {
      scope: "src/**",
      perimeter: { glob: "src/ctx/*/" },
      endState: {
        "~/": {
          layout: "open",
          children: {
            "domain/": {
              layout: "open",
              children: {},
              imports: { message: "the domain reaches itself.", allow: ["~/domain/**"] },
            },
            "adapters/": {
              layout: "open",
              children: {},
              imports: { message: "an adapter reaches the domain and another sector's port.", allow: ["~/domain/**", "~/adapters/**", { sector: "*", via: "~/ports/" }] },
            },
            "ports/": { layout: "open", children: {} },
          },
        },
      },
      objectives: {
        "no-todo": {
          holdout: "file",
          match: { content: { regex: "TODO" } },
          probes: { fires: [{ path: "src/ctx/a/x.ts", source: "// TODO" }] },
        },
      },
    },
  },
  tree: { "src/": { layout: "open", children: {} } },
};
`;

beforeAll(() => {
  mkdirSync(endRoot, { recursive: true });
  const writeEnd = (file: string, source: string): void => {
    const at = path.join(endRoot, file);
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, source);
  };
  writeEnd("architecture.config.mjs", END_MANIFEST);
  writeEnd("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  writeEnd(
    "src/ctx/billing/domain/invoice.ts",
    'import { db } from "../adapters/db.js";\nexport const invoice = db;\n',
  );
  writeEnd(
    "src/ctx/billing/adapters/db.ts",
    'import { port } from "../../orders/ports/port.js";\nexport const db = port;\n',
  );
  writeEnd("src/ctx/orders/ports/port.ts", "export const port = 1;\n");
  writeEnd(
    "src/ctx/orders/domain/order.ts",
    'import { db } from "../../billing/adapters/db.js";\nexport const order = db;\n',
  );
});

afterAll(() => {
  rmSync(endRoot, { force: true, recursive: true });
});

describe("an end state", () => {
  it("expands into the families it lowers to, and each sector's residue against its own root", async () => {
    process.env.ARCHITECTURE_NOW = "2026-10-01T00:00:00Z";
    const policy = await loadPolicy(endRoot);
    expect(policy.campaignRules[0]?.phases.map((one) => [one.id, one.objectives])).toEqual([
      ["end", ["end-state-imports", "end-state-structure"]],
    ]);
    const { output } = await capture(
      checkWith(policy, ["src"], {
        format: "json",
        manifestPath: path.join(endRoot, "architecture.config.mjs"),
      }),
    );
    const report = JSON.parse(output) as CheckReport;
    const hits = report.violations
      .filter((one) => one.kind === "campaign")
      .map((one) => `${one.sector ?? ""} ${one.objective ?? ""} ${one.entry ?? ""}`);
    // billing's domain reaches its adapters: refused. billing's adapter
    // reaches orders through its port: allowed. orders' domain reaches
    // billing's adapter: refused.
    expect(hits).toEqual([
      "src/ctx/billing end-state-imports domain/invoice.ts#src/ctx/billing/adapters/db.ts",
      "src/ctx/orders end-state-imports domain/order.ts#src/ctx/billing/adapters/db.ts",
    ]);
  });
});
