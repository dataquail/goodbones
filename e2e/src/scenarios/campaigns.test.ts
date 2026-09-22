import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { check, cli } from "../cli.js";
import { oxlint } from "../oxlint.js";
import { exports } from "../profile.js";
import { createRepo, type Repo } from "../repo.js";

// A campaign's whole life through the bin, in the minimal shape — one
// objective, the scope as its one sector: declared with no ledger, `clear`,
// a fix, the stale failure, `clear` again, a regression, the
// unrecorded-growth failure, `concede`, and what `conformance` says about
// progress and a stall. Then the phased shape: sectors born by markers, a
// ladder, the derived phase in both hosts, attest, note and the nudge over
// a git diff. The clock is pinned through ARCHITECTURE_NOW, so a stall can
// be made to have happened.

const manifest = (repo: Repo): Readonly<Record<string, unknown>> => ({
  resolve: { scopes: [repo.profile.scope], unresolved: "off" },
  campaigns: {
    "legacy-to-modern": {
      title: "Out of legacy/",
      why: "Nothing new is written under legacy/.",
      how: "Move the module under src/modern/ and update its importers.",
      owner: "@team/platform",
      scope: ["src/**"],
      staleAfter: "14d",
      onComplete: "remove",
      objectives: {
        "out-of-legacy": {
          holdout: "file",
          match: { path: { file: "^src/legacy/" } },
          probes: { fires: [{ path: "src/legacy/old.ts" }], ignores: [{ path: "src/new.ts" }] },
        },
      },
    },
    "no-throw": {
      why: "Errors are returned, not thrown.",
      how: "Return a Result instead of throwing.",
      scope: ["src/**"],
      staleAfter: "30d",
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

type SectorLedger = {
  readonly entered: string;
  readonly initial: number;
  readonly cleared: number;
  readonly closed: number;
  readonly lastCleared: string;
  readonly holdouts: ReadonlyArray<string>;
};

type Ledger = {
  readonly version: number;
  readonly campaign: string;
  readonly objective: string;
  readonly sectors: Readonly<Record<string, SectorLedger>>;
  readonly concessions: ReadonlyArray<Record<string, unknown>>;
};

type ConformanceJson = {
  readonly campaigns: ReadonlyArray<{
    readonly id: string;
    readonly count: number;
    readonly progress: number;
    readonly stalled: boolean;
    readonly complete: boolean;
    readonly ledgered: boolean;
    readonly objectives: ReadonlyArray<{
      readonly id: string;
      readonly cleared: number;
      readonly allowed: number;
    }>;
    readonly phases: ReadonlyArray<{ id: string; defined: boolean; sectors: number }>;
    readonly sectors: ReadonlyArray<{ name: string; phase: string | null }>;
    readonly legacy: { files: number; holdouts: number };
  }>;
};

let repo: Repo;
const at = (now: string) => ({ env: { ARCHITECTURE_NOW: now } });
const ledger = (campaign: string, objective: string): Ledger =>
  JSON.parse(repo.read(`.architecture-campaigns/${campaign}/${objective}.json`)) as Ledger;
const scopeOf = (campaign: string, objective: string): SectorLedger => {
  const scope = ledger(campaign, objective).sectors.scope;
  if (scope === undefined) throw new Error("no implicit sector");
  return scope;
};

beforeAll(() => {
  repo = createRepo({
    files: {
      "src/legacy/one.ts": exports("one"),
      "src/legacy/two.ts": exports("two"),
      "src/fine.ts": exports("fine"),
      "src/thrower.ts":
        'export function parse(x: string) { if (x === "") throw new Error("empty"); return x; }\n',
    },
  });
  repo.writeManifest(manifest(repo));
});

afterAll(() => {
  repo.dispose();
});

describe.sequential("an objective's ledger", () => {
  it("check fails on a campaign with hits and no ledger, naming the command to run", () => {
    const result = check(repo, ["src"]);
    expect(result.code).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.campaigns.map((one) => [one.id, one.count, one.missingLedger])).toEqual([
      ["legacy-to-modern", 2, true],
      ["no-throw", 1, true],
    ]);
    expect(result.stderr).toContain("campaign legacy-to-modern has no ledger");
    expect(result.json.campaigns[0]?.sectors).toEqual([
      { name: "scope", phase: null, reached: null, files: 4, residue: { "out-of-legacy": 2 } },
    ]);
  });

  it("clear writes each ledger from what fires today, and check is then ok", () => {
    const first = cli(
      repo,
      ["objectives", "clear", "legacy-to-modern", "src"],
      at("2026-09-01T00:00:00Z"),
    );
    expect(first.code, first.stderr).toBe(0);
    expect(ledger("legacy-to-modern", "out-of-legacy")).toMatchObject({
      version: 2,
      campaign: "legacy-to-modern",
      objective: "out-of-legacy",
    });
    expect(scopeOf("legacy-to-modern", "out-of-legacy")).toMatchObject({
      initial: 2,
      cleared: 0,
      holdouts: ["src/legacy/one.ts", "src/legacy/two.ts"],
    });
    const second = cli(repo, ["objectives", "clear", "no-throw", "src"], at("2026-09-01T00:00:00Z"));
    expect(second.code, second.stderr).toBe(0);
    expect(scopeOf("no-throw", "throws").holdouts).toEqual([
      expect.stringMatching(/^src\/thrower\.ts#parse#[0-9a-f]{8}$/),
    ]);

    const result = check(repo, ["src"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(
      result.json.violations.filter((one) => one.kind === "campaign").every((one) => one.ledgered),
    ).toBe(true);

    // The family's first verbs are refused by name.
    const retired = cli(repo, ["campaigns", "init", "legacy-to-modern", "src"]);
    expect(retired.code).toBe(1);
    expect(retired.stderr).toContain("`campaigns init` is gone");
  });

  it("fails on a fixed holdout until it is cleared, and clear stamps lastCleared", () => {
    repo.remove("src/legacy/two.ts");
    const stale = check(repo, ["src"]);
    expect(stale.code).toBe(1);
    expect(stale.json.campaigns[0]?.stale).toEqual([
      { objective: "out-of-legacy", sector: "scope", entry: "src/legacy/two.ts" },
    ]);
    expect(stale.stderr).toContain("stale ledger entries");

    const cleared = cli(repo, ["objectives", "clear", "src"], at("2026-09-10T00:00:00Z"));
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(cleared.stdout).toContain(
      "legacy-to-modern/out-of-legacy: 1 holdout cleared; 1 holdout left.",
    );
    expect(scopeOf("legacy-to-modern", "out-of-legacy")).toMatchObject({
      cleared: 1,
      lastCleared: "2026-09-10T00:00:00.000Z",
      holdouts: ["src/legacy/one.ts"],
    });
    expect(check(repo, ["src"]).code).toBe(0);
  });

  it("treats an edit inside the anchored declaration as the same match entry", () => {
    repo.write(
      "src/thrower.ts",
      'export function parse(x: string) {\n  if (x === "") throw new Error("nothing given");\n  return x;\n}\n',
    );
    const result = check(repo, ["src"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.json.campaigns[1]?.drifted).toBe(1);
    const cleared = cli(repo, ["objectives", "clear", "no-throw", "src"]);
    expect(cleared.stdout).toContain("no-throw/throws: 1 holdout rewritten; 1 holdout left.");
    expect(scopeOf("no-throw", "throws").cleared).toBe(0);
  });

  it("fails on unrecorded growth, and concede records it with a reason and an author", () => {
    repo.write("src/legacy/three.ts", exports("three"));
    const grown = check(repo, ["src"]);
    expect(grown.code).toBe(1);
    expect(grown.json.campaigns[0]?.new).toEqual([
      { objective: "out-of-legacy", sector: "scope", entry: "src/legacy/three.ts" },
    ]);
    expect(grown.stderr).toContain("unrecorded campaign growth");

    const refused = cli(repo, ["objectives", "concede", "legacy-to-modern", "src"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--reason");

    const conceded = cli(
      repo,
      [
        "objectives",
        "concede",
        "legacy-to-modern",
        "--reason",
        "vendored until v4",
        "--by",
        "someone@example.com",
        "src",
      ],
      at("2026-09-12T00:00:00Z"),
    );
    expect(conceded.code, conceded.stderr).toBe(0);
    expect(ledger("legacy-to-modern", "out-of-legacy").concessions).toEqual([
      {
        sector: "scope",
        at: "2026-09-12T00:00:00.000Z",
        by: "someone@example.com",
        delta: 1,
        reason: "vendored until v4",
        holdouts: ["src/legacy/three.ts"],
      },
    ]);
    expect(check(repo, ["src"]).code).toBe(0);
  });

  it("fails when the ledger does not add up", () => {
    const written = ledger("legacy-to-modern", "out-of-legacy");
    const scope = written.sectors.scope;
    if (scope === undefined) throw new Error("no implicit sector");
    repo.write("src/legacy/four.ts", exports("four"));
    repo.write(
      ".architecture-campaigns/legacy-to-modern/out-of-legacy.json",
      JSON.stringify({
        ...written,
        sectors: { scope: { ...scope, holdouts: [...scope.holdouts, "src/legacy/four.ts"] } },
      }),
    );
    const result = check(repo, ["src"]);
    expect(result.code).toBe(1);
    expect(result.json.campaigns[0]?.arithmetic).toBe(false);
    expect(result.stderr).toContain("ledger arithmetic does not hold");
    repo.remove("src/legacy/four.ts");
    repo.write(
      ".architecture-campaigns/legacy-to-modern/out-of-legacy.json",
      `${JSON.stringify(written, null, 2)}\n`,
    );
    expect(check(repo, ["src"]).code).toBe(0);
  });

  it("conformance reports progress, and a stall once staleAfter has passed", () => {
    const fresh = cli(repo, ["conformance", "--json", "src"], at("2026-09-20T00:00:00Z"));
    expect(fresh.code, fresh.stderr).toBe(0);
    const before = JSON.parse(fresh.stdout) as ConformanceJson;
    expect(
      before.campaigns.map((one) => [
        one.id,
        one.count,
        one.objectives[0]?.cleared,
        one.objectives[0]?.allowed,
        one.stalled,
      ]),
    ).toEqual([
      ["legacy-to-modern", 2, 1, 1, false],
      ["no-throw", 1, 0, 0, false],
    ]);
    // 2 left of 3 ever ledgered.
    expect(before.campaigns[0]?.progress).toBeCloseTo(1 / 3);

    const later = cli(repo, ["conformance", "--json", "src"], at("2026-10-15T00:00:00Z"));
    const after = JSON.parse(later.stdout) as ConformanceJson;
    expect(after.campaigns.map((one) => one.stalled)).toEqual([true, true]);
    const text = cli(repo, ["conformance", "src"], at("2026-10-15T00:00:00Z"));
    expect(text.stdout).toContain("campaigns: 2 campaigns, 2 stalled");

    // A stall is a notice in check, not a failure.
    const checked = check(repo, ["src"], at("2026-10-15T00:00:00Z"));
    expect(checked.code, checked.stderr).toBe(0);
    expect(checked.json.campaigns.every((one) => one.stalled)).toBe(true);
    const prose = cli(repo, ["check", "src"], at("2026-10-15T00:00:00Z"));
    expect(prose.stdout).toContain("notice: campaign legacy-to-modern has stalled");
  });

  it("fails a complete campaign declared onComplete: remove, and keeps one declared keep", () => {
    repo.remove("src/legacy/one.ts");
    repo.remove("src/legacy/three.ts");
    const cleared = cli(repo, ["objectives", "clear", "legacy-to-modern", "src"]);
    expect(cleared.code, cleared.stderr).toBe(0);
    const result = check(repo, ["src"]);
    expect(result.code).toBe(1);
    expect(result.json.campaigns[0]).toMatchObject({ complete: true, onComplete: "remove" });
    expect(result.stderr).toContain("complete and declared onComplete: remove");

    repo.write("src/thrower.ts", exports("safe"));
    cli(repo, ["objectives", "clear", "no-throw", "src"]);
    const status = cli(repo, ["campaigns", "src"]);
    expect(status.stdout).toMatch(/no-throw\s+100%\s+0 left.*complete/);
  });
});

// The phased shape: bounded contexts born by a `context.ts` marker, a
// ladder from `domain` to an open `aggregates`, a windowed presence and an
// attested step. Both hosts read the derived phase; the nudge reads a diff.
const phased = (): Readonly<Record<string, unknown>> => ({
  resolve: { scopes: [repo.profile.scope], unresolved: "off" },
  campaigns: {
    "billing-ddd": {
      why: "The billing mud becomes bounded contexts.",
      how: "Move the call behind the port.",
      scope: "src/**",
      perimeter: { marker: "**/context.ts" },
      phases: [
        { id: "domain", objectives: ["no-io"] },
        { id: "repository", objectives: ["no-knex", "has-migration"] },
        { id: "dual-write", objectives: ["has-flag"] },
        { id: "backfilled", intent: "rows copied", attested: true },
        { id: "cutover", objectives: ["no-flag"] },
        { id: "aggregates", intent: "Model refunds inside billing, or split them out." },
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
        "has-migration": { holdout: "sector", sector: { has: { path: { file: "/migrations/" } } } },
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

let ladder: Repo;
// git sets GIT_DIR, GIT_INDEX_FILE and friends in the environment of every
// hook it runs, and those WIN OVER `cwd`. Inheriting them means a fixture's
// `git init` + `git commit` in a temp directory silently retargets whatever
// repository invoked the hook — which, when `pnpm run precommit` runs as the
// pre-commit hook, is this one. That is not hypothetical: it committed a
// fixture over the working tree and left the branch pointing at it.
//
// So the fixture's git runs with the ambient repository stripped out of the
// environment, and `cwd` means what it says.
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

const withoutAmbientGit = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !AMBIENT_GIT.includes(key)));

const git = (...args: ReadonlyArray<string>): string =>
  execFileSync("git", args, {
    cwd: ladder.root,
    encoding: "utf8",
    env: {
      ...withoutAmbientGit(process.env),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
    stdio: ["ignore", "pipe", "ignore"],
  });

beforeAll(() => {
  ladder = createRepo({
    files: {
      "src/billing/context.ts": 'export const sector = { name: "billing" };\n',
      "src/billing/service.ts":
        "export function reconcile() {\n  const text = readFileSync('x');\n  return knex(text);\n}\n",
      "src/orders/context.ts": "export const port = 1;\n",
      "src/orders/service.ts": "export const place = () => 1;\n",
      "src/orders/migrations/001.ts": "export const up = () => 1;\n",
      "src/services/legacy.ts": "export const old = () => readFileSync('y');\n",
    },
  });
  ladder.writeManifest(phased());
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
});

afterAll(() => {
  ladder.dispose();
});

describe.sequential("a campaign with sectors and phases", () => {
  it("births sectors from the markers and derives their phases, in both hosts", () => {
    const result = check(ladder, ["src"]);
    expect(result.code).toBe(1);
    expect(result.json.campaigns[0]?.sectors.map((one) => [one.name, one.phase])).toEqual([
      ["billing", "domain"],
      ["orders", "dual-write"],
      ["legacy", "domain"],
    ]);
    // Only what is in window counts: billing's knex call is not yet.
    expect(
      result.json.violations
        .filter((one) => one.kind === "campaign")
        .map((one) => `${one.sector ?? ""}/${one.objective ?? ""}`),
    ).toEqual(["billing/no-io", "legacy/no-io", "orders/has-flag"]);

    const cleared = cli(ladder, ["objectives", "clear", "src"], at("2026-10-01T00:00:00Z"));
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(check(ladder, ["src"]).code).toBe(0);

    // The plugin reads the same ledgers: nothing to say once cleared, and
    // a new I/O call in billing is unrecorded growth at `domain`, while a
    // new knex call is not in window there.
    const quiet = oxlint(ladder, ["src"]);
    expect(quiet.loaded, quiet.stdout + quiet.stderr).toBe(true);
    expect(quiet.diagnostics.filter((one) => one.rule === "architecture/campaigns")).toEqual([]);
    ladder.write(
      "src/billing/service.ts",
      "export function reconcile() {\n  const text = readFileSync('x');\n  return knex(text);\n}\nexport function more() {\n  readFileSync('z');\n  return knex('w');\n}\n",
    );
    const linted = oxlint(ladder, ["src"]);
    expect(linted.loaded, linted.stdout + linted.stderr).toBe(true);
    expect(
      linted.diagnostics
        .filter((one) => one.rule === "architecture/campaigns")
        .map((one) => one.message),
    ).toEqual(["[campaign/billing-ddd/no-io] Move the call behind the port."]);
    const grown = check(ladder, ["src"]);
    expect(grown.json.campaigns[0]?.new).toEqual([
      expect.objectContaining({ objective: "no-io", sector: "billing" }),
    ]);
  });

  it("nudges a diff: the phase, what would move it on, and a verdict a hook reads", () => {
    const nudged = cli(ladder, ["campaigns", "status", "--changed", "--json", "src"]);
    expect(nudged.code).toBe(1);
    const nudge = JSON.parse(nudged.stdout) as {
      ok: boolean;
      sectors: ReadonlyArray<Record<string, unknown>>;
    };
    expect(nudge.ok).toBe(false);
    expect(nudge.sectors[0]).toMatchObject({
      campaign: "billing-ddd",
      sector: "billing",
      phase: { id: "domain", index: 0, of: 6, open: false },
      onTouch: "ratchet",
      ask: "hold",
      verdict: "back",
      toward: { "no-io": 2 },
    });
    const text = cli(ladder, ["campaigns", "status", "--changed", "src"]);
    expect(text.stdout).toContain("billing — phase domain (1 of 6)");
    expect(text.stdout).toContain("onTouch: ratchet — back");
  });

  it("moves a sector along the ladder: attest at the phase, note at the open end", () => {
    git("checkout", "-q", "--", "src");
    ladder.write("src/orders/service.ts", "export const place = () => flags.dualWrite;\n");
    cli(ladder, ["objectives", "clear", "src"], at("2026-10-02T00:00:00Z"));
    const attested = cli(
      ladder,
      ["campaigns", "attest", "orders", "backfilled", "--reason", "ran", "--by", "me", "src"],
      at("2026-10-03T00:00:00Z"),
    );
    expect(attested.code, attested.stderr).toBe(0);
    // Past the attested step, the sector reaches `cutover`, where the flag
    // is a holdout — and `has-flag`'s window is shut for it for good, so
    // removing the flag moves it to the open end rather than back.
    cli(ladder, ["objectives", "clear", "src"], at("2026-10-03T12:00:00Z"));
    ladder.write("src/orders/service.ts", "export const place = () => 2;\n");
    cli(ladder, ["objectives", "clear", "src"], at("2026-10-04T00:00:00Z"));
    const noted = cli(
      ladder,
      ["campaigns", "note", "orders", "refunds never write invoices", "--by", "me", "src"],
      at("2026-10-05T00:00:00Z"),
    );
    expect(noted.code, noted.stderr).toBe(0);
    const snapshot = JSON.parse(
      cli(ladder, ["conformance", "--json", "src"]).stdout,
    ) as ConformanceJson;
    expect(snapshot.campaigns[0]?.phases.map((one) => [one.id, one.sectors])).toEqual([
      ["domain", 1],
      ["repository", 0],
      ["dual-write", 0],
      ["backfilled", 0],
      ["cutover", 0],
      ["aggregates", 1],
    ]);
    expect(snapshot.campaigns[0]?.legacy).toEqual({ files: 1, holdouts: 1 });
    const record = JSON.parse(
      ladder.read(".architecture-campaigns/billing-ddd/sectors/orders.json"),
    ) as { reached: string; attested: ReadonlyArray<unknown>; notes: ReadonlyArray<unknown> };
    expect(record.reached).toBe("aggregates");
    expect(record.attested).toHaveLength(1);
    expect(record.notes).toHaveLength(1);
  });
});
