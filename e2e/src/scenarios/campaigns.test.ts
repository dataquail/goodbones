import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { check, cli } from "../cli.js";
import { exports } from "../profile.js";
import { createRepo, type Repo } from "../repo.js";

// A campaign's whole life through the bin: declared with no ledger, `init`,
// a fix, the stale failure, `prune`, a regression, the unrecorded-growth
// failure, `allow`, and what `conformance` says about progress and a stall.
// The clock is pinned through ARCHITECTURE_NOW, so a stall can be made to
// have happened.

const manifest = (repo: Repo): Readonly<Record<string, unknown>> => ({
  resolve: { scopes: [repo.profile.scope], unresolved: "off" },
  campaigns: [
    {
      id: "legacy-to-modern",
      title: "Out of legacy/",
      why: "Nothing new is written under legacy/.",
      how: "Move the module under src/modern/ and update its importers.",
      owner: "@team/platform",
      scope: ["src/**"],
      unit: "file",
      detect: { path: { file: "^src/legacy/" } },
      probes: { fires: [{ path: "src/legacy/old.ts" }], ignores: [{ path: "src/new.ts" }] },
      staleAfter: "14d",
      onComplete: "remove",
    },
    {
      id: "no-throw",
      why: "Errors are returned, not thrown.",
      how: "Return a Result instead of throwing.",
      scope: ["src/**"],
      unit: "match",
      detect: { syntax: { pattern: "throw new Error($$$)" } },
      probes: {
        fires: [{ path: "src/a.ts", source: "function f() { throw new Error('x'); }" }],
        ignores: [{ path: "src/b.ts", source: "function f() { return 1; }" }],
      },
      staleAfter: "30d",
    },
  ],
  tree: { "src/": { layout: "open", children: {} } },
});

type Ledger = {
  readonly initial: number;
  readonly fixed: number;
  readonly lastProgress: string;
  readonly regressions: ReadonlyArray<{
    readonly at: string;
    readonly by: string;
    readonly delta: number;
    readonly reason: string;
    readonly entries: ReadonlyArray<string>;
  }>;
  readonly entries: ReadonlyArray<string>;
};

type ConformanceJson = {
  readonly campaigns: ReadonlyArray<{
    readonly id: string;
    readonly count: number;
    readonly fixed: number;
    readonly allowed: number;
    readonly progress: number;
    readonly stalled: boolean;
    readonly complete: boolean;
    readonly ledgered: boolean;
  }>;
};

let repo: Repo;
const at = (now: string) => ({ env: { ARCHITECTURE_NOW: now } });
const ledger = (id: string): Ledger =>
  JSON.parse(repo.read(`.architecture-campaigns/${id}.json`)) as Ledger;

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

describe.sequential("a campaign's ledger", () => {
  it("check fails on a campaign with hits and no ledger, naming the command to run", () => {
    const result = check(repo, ["src"]);
    expect(result.code).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.campaigns.map((one) => [one.id, one.count, one.missingLedger])).toEqual([
      ["legacy-to-modern", 2, true],
      ["no-throw", 1, true],
    ]);
    expect(result.stderr).toContain("campaign legacy-to-modern has no ledger");
  });

  it("init writes each ledger from what fires today, and check is then ok", () => {
    const first = cli(
      repo,
      ["campaigns", "init", "legacy-to-modern", "src"],
      at("2026-09-01T00:00:00Z"),
    );
    expect(first.code, first.stderr).toBe(0);
    expect(ledger("legacy-to-modern")).toMatchObject({
      initial: 2,
      fixed: 0,
      entries: ["src/legacy/one.ts", "src/legacy/two.ts"],
    });
    const second = cli(repo, ["campaigns", "init", "no-throw", "src"], at("2026-09-01T00:00:00Z"));
    expect(second.code, second.stderr).toBe(0);
    expect(ledger("no-throw").entries).toEqual([
      expect.stringMatching(/^src\/thrower\.ts#parse#[0-9a-f]{8}$/),
    ]);

    const result = check(repo, ["src"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(
      result.json.violations.filter((one) => one.kind === "campaign").every((one) => one.ledgered),
    ).toBe(true);

    const again = cli(repo, ["campaigns", "init", "legacy-to-modern", "src"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("already exists");
  });

  it("fails on a fixed entry until it is pruned, and prune stamps lastProgress", () => {
    repo.remove("src/legacy/two.ts");
    const stale = check(repo, ["src"]);
    expect(stale.code).toBe(1);
    expect(stale.json.campaigns[0]?.stale).toEqual(["src/legacy/two.ts"]);
    expect(stale.stderr).toContain("stale ledger entries");

    const pruned = cli(repo, ["campaigns", "prune", "src"], at("2026-09-10T00:00:00Z"));
    expect(pruned.code, pruned.stderr).toBe(0);
    expect(pruned.stdout).toContain("legacy-to-modern: 1 entry pruned; 1 entry left.");
    expect(ledger("legacy-to-modern")).toMatchObject({
      fixed: 1,
      lastProgress: "2026-09-10T00:00:00.000Z",
      entries: ["src/legacy/one.ts"],
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
    const pruned = cli(repo, ["campaigns", "prune", "no-throw", "src"]);
    expect(pruned.stdout).toContain("no-throw: 0 entries pruned, 1 entry rewritten; 1 entry left.");
    expect(ledger("no-throw").fixed).toBe(0);
  });

  it("fails on unrecorded growth, and allow records the regression with a reason and an author", () => {
    repo.write("src/legacy/three.ts", exports("three"));
    const grown = check(repo, ["src"]);
    expect(grown.code).toBe(1);
    expect(grown.json.campaigns[0]?.new).toEqual(["src/legacy/three.ts"]);
    expect(grown.stderr).toContain("unrecorded campaign growth");

    const refused = cli(repo, ["campaigns", "allow", "legacy-to-modern", "src"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--reason");

    const allowed = cli(
      repo,
      [
        "campaigns",
        "allow",
        "legacy-to-modern",
        "--reason",
        "vendored until v4",
        "--by",
        "someone@example.com",
        "src",
      ],
      at("2026-09-12T00:00:00Z"),
    );
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(ledger("legacy-to-modern").regressions).toEqual([
      {
        at: "2026-09-12T00:00:00.000Z",
        by: "someone@example.com",
        delta: 1,
        reason: "vendored until v4",
        entries: ["src/legacy/three.ts"],
      },
    ]);
    expect(check(repo, ["src"]).code).toBe(0);
  });

  it("fails when the ledger does not add up", () => {
    const written = ledger("legacy-to-modern");
    repo.write("src/legacy/four.ts", exports("four"));
    repo.write(
      ".architecture-campaigns/legacy-to-modern.json",
      JSON.stringify({ ...written, entries: [...written.entries, "src/legacy/four.ts"] }),
    );
    const result = check(repo, ["src"]);
    expect(result.code).toBe(1);
    expect(result.json.campaigns[0]?.arithmetic).toBe(false);
    expect(result.stderr).toContain("ledger arithmetic does not hold");
    repo.remove("src/legacy/four.ts");
    repo.write(
      ".architecture-campaigns/legacy-to-modern.json",
      `${JSON.stringify(written, null, 2)}\n`,
    );
    expect(check(repo, ["src"]).code).toBe(0);
  });

  it("conformance reports progress, and a stall once staleAfter has passed", () => {
    const fresh = cli(repo, ["conformance", "--json", "src"], at("2026-09-20T00:00:00Z"));
    expect(fresh.code, fresh.stderr).toBe(0);
    const before = JSON.parse(fresh.stdout) as ConformanceJson;
    expect(
      before.campaigns.map((one) => [one.id, one.count, one.fixed, one.allowed, one.stalled]),
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
    const pruned = cli(repo, ["campaigns", "prune", "legacy-to-modern", "src"]);
    expect(pruned.code, pruned.stderr).toBe(0);
    const result = check(repo, ["src"]);
    expect(result.code).toBe(1);
    expect(result.json.campaigns[0]).toMatchObject({ complete: true, onComplete: "remove" });
    expect(result.stderr).toContain("complete and declared onComplete: remove");

    repo.write("src/thrower.ts", exports("safe"));
    cli(repo, ["campaigns", "prune", "no-throw", "src"]);
    const status = cli(repo, ["campaigns", "src"]);
    expect(status.stdout).toMatch(/no-throw\s+100%\s+0 left.*complete/);
  });
});
