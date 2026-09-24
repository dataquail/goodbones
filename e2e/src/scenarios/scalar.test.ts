import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { check, cli } from "../cli.js";
import { oxlint } from "../oxlint.js";
import { createRepo, type Repo } from "../repo.js";

// A scalar objective through the bin and the plugin: a sector's non-blank
// lines, recorded by `clear`, unchanged by splitting a file in two, risen
// only by `concede`, read before and after a diff by the nudge — and, in
// the plugin, which cannot sum a sector, the recorded number is what places
// the sector at its phase. Assertions are on `--json` and the ledger file.

type MeasureLedger = {
  readonly kind: string;
  readonly direction: string;
  readonly sectors: Readonly<
    Record<string, { initial: number; recorded: number; improved: number; closed: number | null }>
  >;
  readonly concessions: ReadonlyArray<Record<string, unknown>>;
};

const manifest = (repo: Repo): Readonly<Record<string, unknown>> => ({
  resolve: { scopes: [repo.profile.scope], unresolved: "off" },
  campaigns: {
    shrink: {
      why: "The service shrinks until the port is all that is left.",
      how: "Move a use case behind the port.",
      scope: ["src/**"],
      perimeter: { marker: "**/context.ts" },
      phases: [
        { id: "small", objectives: ["lines"] },
        { id: "ported", objectives: ["no-services"] },
      ],
      objectives: {
        lines: { measure: { lines: true }, direction: "down", target: 3 },
        "no-services": {
          holdout: "file",
          match: { path: { file: "service" } },
          probes: {
            fires: [{ path: "src/a/service.ts" }],
            ignores: [{ path: "src/a/port.ts" }],
          },
        },
      },
    },
  },
  tree: { "src/": { layout: "open", children: {} } },
});

const lines = (count: number, prefix = "a"): string =>
  Array.from({ length: count }, (_, i) => `export const ${prefix}${String(i)} = ${String(i)};`)
    .join("\n\n")
    .concat("\n");

let repo: Repo;
const at = (now: string) => ({ env: { ARCHITECTURE_NOW: now } });
const ledger = (): MeasureLedger =>
  JSON.parse(repo.read(".architecture-campaigns/shrink/lines.json")) as MeasureLedger;
const campaignDiagnostics = () =>
  oxlint(repo, ["src"]).diagnostics.filter((one) => one.rule === "architecture/campaigns");

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
    cwd: repo.root,
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

beforeAll(() => {
  repo = createRepo({
    files: {
      "src/billing/context.ts": 'export const sector = { name: "billing" };\n',
      // Eight non-blank lines of service and one of marker: nine.
      "src/billing/service.ts": lines(8),
    },
  });
  repo.writeManifest(manifest(repo));
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
});

afterAll(() => {
  repo.dispose();
});

describe.sequential("a scalar objective", () => {
  it("check measures the sector and asks for a clear, which records it as a number", () => {
    const before = check(repo, ["src"]);
    expect(before.code).toBe(1);
    const [campaign] = before.json.campaigns;
    expect(campaign?.missingLedger).toBe(true);
    expect(campaign?.objectives.find((one) => one.id === "lines")?.measure).toEqual({
      direction: "down",
      value: 9,
      recorded: null,
      target: 3,
      tolerance: 0,
    });
    expect(campaign?.sectors).toEqual([
      { name: "billing", phase: "small", reached: null, files: 2, residue: { lines: 6 } },
    ]);

    const cleared = cli(repo, ["objectives", "clear", "src"], at("2026-10-01T00:00:00Z"));
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(ledger()).toMatchObject({
      kind: "measure",
      direction: "down",
      sectors: { billing: { initial: 9, recorded: 9, improved: 0, closed: null } },
    });
    expect(check(repo, ["src"]).code).toBe(0);
  });

  it("measures the same after a file is split in two", () => {
    repo.write("src/billing/service.ts", lines(5));
    repo.write("src/billing/service-more.ts", lines(3, "b"));
    const split = check(repo, ["src"]);
    expect(split.code, split.stderr).toBe(0);
    expect(split.json.campaigns[0]?.objectives[0]?.measure?.value).toBe(9);
    git("add", "-A");
    git("commit", "-q", "-m", "split");
  });

  it("holds the sector at its phase in the plugin, reading the recorded number", () => {
    // `no-services` belongs to `ported`: while the record is short of its
    // target, a new service file is not in window.
    expect(campaignDiagnostics()).toEqual([]);
  });

  it("fails on a rise, nudges it back, and takes a concession with a reason", () => {
    repo.write("src/billing/service.ts", lines(7));
    const grown = check(repo, ["src"]);
    expect(grown.code).toBe(1);
    expect(grown.json.campaigns[0]?.new).toEqual([
      { objective: "lines", sector: "billing", entry: "measured 11, recorded 9" },
    ]);
    const nudged = cli(repo, ["campaigns", "status", "--changed", "--json", "src"]);
    expect(nudged.code).toBe(1);
    const nudge = JSON.parse(nudged.stdout) as { sectors: ReadonlyArray<Record<string, unknown>> };
    expect(nudge.sectors[0]).toMatchObject({
      sector: "billing",
      verdict: "back",
      measures: [{ objective: "lines", before: 9, after: 11, target: 3, back: true }],
    });
    const conceded = cli(
      repo,
      ["objectives", "concede", "shrink/lines", "--reason", "a use case landed first", "--by", "me", "src"],
      at("2026-10-02T00:00:00Z"),
    );
    expect(conceded.code, conceded.stderr).toBe(0);
    expect(ledger().concessions).toEqual([
      expect.objectContaining({ sector: "billing", from: 9, to: 11, by: "me" }),
    ]);
    expect(check(repo, ["src"]).code).toBe(0);
  });

  it("lets the sector on at its target, in both hosts", () => {
    repo.write("src/billing/service.ts", lines(1));
    repo.remove("src/billing/service-more.ts");
    const stale = check(repo, ["src"]);
    expect(stale.code).toBe(1);
    expect(stale.json.campaigns[0]?.stale).toEqual([
      { objective: "lines", sector: "billing", entry: "measured 2, recorded 11" },
    ]);
    const cleared = cli(repo, ["objectives", "clear", "src"], at("2026-10-03T00:00:00Z"));
    expect(cleared.code, cleared.stderr).toBe(0);
    const after = check(repo, ["src"]);
    expect(after.code, after.stderr).toBe(0);
    expect(after.json.campaigns[0]?.sectors[0]).toMatchObject({ phase: "ported" });

    // The plugin reads the new record: the sector is at `ported`, so a new
    // service file is unrecorded growth there.
    repo.write("src/billing/other-service.ts", "export const x = 1;\n");
    expect(campaignDiagnostics().map((one) => one.message)).toEqual([
      "[campaign/shrink/no-services] Move a use case behind the port.",
    ]);
  });
});
