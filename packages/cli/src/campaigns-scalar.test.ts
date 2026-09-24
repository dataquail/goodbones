import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  conformance,
  explain,
  objectives,
} from "./run.js";

// A campaign with a scalar objective, driven through the CLI: a sector's
// non-blank lines held to what `clear` last recorded, improved by `clear`,
// risen only by `concede`, placing the sector at its phase until the number
// reaches its target — and the nudge reading the number before and after a
// diff.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../.tmp-cli-scalar-tests");

// JSON, not a module: the module loader caches a `.mjs` manifest for the
// life of the process.
const MANIFEST = JSON.stringify({
  resolve: {
    scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }],
    unresolved: "off",
  },
  campaigns: {
    shrink: {
      why: "The service shrinks until the port is all that is left.",
      scope: "src/**",
      perimeter: { marker: "**/context.ts" },
      staleAfter: "30d",
      phases: [
        { id: "small", objectives: ["lines"] },
        { id: "ported", objectives: ["no-knex"] },
      ],
      objectives: {
        lines: {
          how: "Delete what the port made dead.",
          measure: { lines: true },
          direction: "down",
          target: 4,
        },
        files: { measure: { files: true }, direction: "down", tolerance: 1 },
        "no-knex": {
          holdout: "match",
          match: { syntax: { pattern: "knex($$$)" } },
          probes: { fires: [{ path: "src/a.ts", source: "knex('x')" }] },
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
// hook's GIT_DIR wins over `cwd`, and would commit the fixture over this
// repository (see campaigns.test.ts).
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

const check = async (now?: string) => {
  const result = await capture(
    checkWith(await policyAt(now), ["src"], {
      format: "json",
      manifestPath: path.join(root, "architecture.json"),
    }),
  );
  return { ...result, report: JSON.parse(result.output) as CheckReport };
};

const checkText = async () =>
  capture(
    checkWith(await policyAt(), ["src"], {
      format: "text",
      manifestPath: path.join(root, "architecture.json"),
    }),
  );

const ledger = (objective: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(path.join(root, ".architecture-campaigns", "shrink", `${objective}.json`), "utf8"),
  ) as Record<string, unknown>;

const SERVICE = (lines: number): string =>
  [
    "export function reconcile() {",
    ...Array.from(
      { length: lines - 2 },
      (_, i) => `  const step${String(i)} = knex('t${String(i)}');`,
    ),
    "}",
    "",
    "",
  ].join("\n");

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  write("architecture.json", MANIFEST);
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  write("src/billing/context.ts", 'export const sector = { name: "billing" };\n');
  // One line of marker and eight of service: nine, against a target of 4.
  write("src/billing/service.ts", SERVICE(8));
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
});

afterAll(() => {
  delete process.env.ARCHITECTURE_NOW;
  rmSync(root, { force: true, recursive: true });
});

describe.sequential("a scalar objective", () => {
  it("measures each sector, holds it at the phase naming the scalar, and asks for a clear", async () => {
    const { exit, report } = await check();
    expect(Exit.isFailure(exit)).toBe(true);
    const [campaign] = report.campaigns;
    expect(campaign?.missingLedger).toBe(true);
    expect(campaign?.sectors).toEqual([
      // Nine lines against a target of 4: five to go, at `small`. The
      // standing `files` measure has no target and is never residue.
      { name: "billing", phase: "small", reached: null, files: 2, residue: { lines: 5, files: 0 } },
    ]);
    // A scalar is no hit: the knex calls are not in window yet, and the
    // number is no violation.
    expect(report.violations.filter((one) => one.kind === "campaign")).toEqual([]);
    expect(campaign?.objectives.find((one) => one.id === "lines")?.measure).toEqual({
      direction: "down",
      value: 9,
      recorded: null,
      target: 4,
      tolerance: 0,
    });
    const text = await checkText();
    expect(text.output).toContain("lines · billing  (measures 9)");
  });

  it("clear records the sector at its value, as the second ledger schema", async () => {
    const cleared = await capture(objectives(await policyAt(), ["src"], ["clear"]));
    expect(Exit.isSuccess(cleared.exit), cleared.failure).toBe(true);
    expect(cleared.output).toContain("shrink/lines: 1 sector entered (billing); held to 9.");
    expect(cleared.output).toContain("shrink/files: 1 sector entered (billing); held to 2.");
    expect(ledger("lines")).toMatchObject({
      version: 2,
      kind: "measure",
      direction: "down",
      sectors: { billing: { initial: 9, recorded: 9, improved: 0, closed: null } },
      concessions: [],
    });
    const { exit } = await check();
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("fails check on an improvement clear has not recorded, and clear records it", async () => {
    write("src/billing/service.ts", SERVICE(6));
    const { exit, report } = await check();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(report.campaigns[0]?.stale).toEqual([
      { objective: "lines", sector: "billing", entry: "measured 7, recorded 9" },
    ]);
    const cleared = await capture(objectives(await policyAt(), ["src"], ["clear"]));
    expect(cleared.output).toContain("shrink/lines: 1 sector improved (billing 9 → 7); held to 7.");
    expect(ledger("lines")).toMatchObject({
      sectors: { billing: { initial: 9, recorded: 7, improved: 2 } },
    });
    expect(Exit.isSuccess((await check()).exit)).toBe(true);
    git("add", "-A");
    git("commit", "-q", "-m", "shrink");
  });

  it("gives a wobbling measure its tolerance", async () => {
    // One file more is within the `files` measure's tolerance of 1.
    write("src/billing/empty.ts", "");
    expect(Exit.isSuccess((await check()).exit)).toBe(true);
    rmSync(path.join(root, "src/billing/empty.ts"));
  });

  it("nudges a diff that sends the number back, and fails check until the rise is conceded", async () => {
    write("src/billing/service.ts", SERVICE(8));
    const nudged = await capture(
      campaigns(await policyAt(), ["src"], ["status", "--changed", "--json"]),
    );
    expect(Exit.isFailure(nudged.exit)).toBe(true);
    const nudge = JSON.parse(nudged.output) as { sectors: Array<Record<string, unknown>> };
    expect(nudge.sectors[0]).toMatchObject({
      sector: "billing",
      phase: { id: "small" },
      onTouch: "ratchet",
      verdict: "back",
      residue: { before: { lines: 3 }, after: { lines: 5 } },
      measures: [
        {
          objective: "lines",
          direction: "down",
          before: 7,
          after: 9,
          target: 4,
          tolerance: 0,
          back: true,
        },
        {
          objective: "files",
          direction: "down",
          before: 2,
          after: 2,
          target: null,
          tolerance: 1,
          back: false,
        },
      ],
    });
    const text = await capture(campaigns(await policyAt(), ["src"], ["status", "--changed"]));
    expect(text.output).toContain("lines: 7 → 9 (target 4)  back");

    const { exit, report } = await check();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(report.campaigns[0]?.new).toEqual([
      { objective: "lines", sector: "billing", entry: "measured 9, recorded 7" },
    ]);

    const refused = await capture(
      objectives(
        await policyAt(),
        ["src"],
        ["concede", "shrink/lines", "--reason", "x", "--by", "me", "--holdouts", "a"],
      ),
    );
    expect(refused.failure).toMatch(/is a scalar objective: it has no holdouts to choose among/);

    const conceded = await capture(
      objectives(
        await policyAt(),
        ["src"],
        [
          "concede",
          "shrink/lines",
          "--reason",
          "the port needs the old path a sprint longer",
          "--by",
          "me",
        ],
      ),
    );
    expect(Exit.isSuccess(conceded.exit), conceded.failure).toBe(true);
    expect(conceded.output).toContain("shrink/lines: a rise conceded in 1 sector, recorded by me.");
    expect(conceded.output).toContain("billing · 7 → 9");
    expect(ledger("lines")).toMatchObject({
      sectors: { billing: { initial: 9, recorded: 9, improved: 2 } },
      concessions: [
        expect.objectContaining({
          sector: "billing",
          from: 7,
          to: 9,
          by: "me",
          reason: "the port needs the old path a sprint longer",
        }),
      ],
    });
    expect(Exit.isSuccess((await check()).exit)).toBe(true);
  });

  it("explains what a file adds to its sector's number", async () => {
    const explained = await capture(explain(await policyAt(), "src/billing/service.ts", ["src"]));
    expect(explained.output).toContain("lines: the sector measures 9, held to 9, target 4");
    expect(explained.output).toContain(
      "campaign/shrink/lines — The service shrinks until the port is all that is left. (measure, down; 8 here)",
    );
  });

  it("lets the sector on once the number reaches its target, and the next phase's window opens", async () => {
    write("src/billing/service.ts", "export const reconcile = () => knex('t');\n");
    const cleared = await capture(objectives(await policyAt(), ["src"], ["clear"]));
    expect(cleared.output).toContain("shrink/lines: 1 sector improved (billing 9 → 2); held to 2.");
    expect(cleared.output).toContain("shrink/no-knex: 1 sector entered (billing); 1 holdout left.");
    const { exit, report } = await check();
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(report.campaigns[0]?.sectors[0]).toMatchObject({
      phase: "ported",
      residue: { lines: 0, files: 0, "no-knex": 1 },
    });
  });

  it("prints the number in the status table", async () => {
    const status = await capture(campaigns(await policyAt(), ["src"], []));
    expect(status.output).toContain("lines    100%  measures 2, held to 2, target 4");
    expect(status.output).toContain("files      0%  measures 2, held to 2");
  });

  it("carries the number in the conformance snapshot", async () => {
    const snapshot = await capture(
      conformance(await policyAt(), ["src"], {
        format: "json",
        manifestPath: path.join(root, "architecture.json"),
      }),
    );
    const parsed = JSON.parse(snapshot.output) as {
      campaigns: Array<{ objectives: Array<Record<string, unknown>> }>;
    };
    expect(parsed.campaigns[0]?.objectives.find((one) => one.id === "lines")).toMatchObject({
      phase: "small",
      count: 0,
      complete: true,
      ledgered: true,
      concessions: 1,
      measure: { direction: "down", value: 2, recorded: 2, target: 4, tolerance: 0 },
    });
  });
});

// A number about the repository: a command run once from its root, the
// campaign's scope its one sector.
const commandRoot = path.resolve(here, "../../../.tmp-cli-scalar-command-tests");

const COMMAND_MANIFEST = (command: string): string =>
  JSON.stringify({
    resolve: {
      scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }],
      unresolved: "off",
    },
    campaigns: {
      bundle: {
        scope: "src/**",
        objectives: {
          size: {
            measure: { command, pattern: "size: (?<value>[0-9.]+)" },
            direction: "down",
            tolerance: 5,
          },
        },
      },
    },
    tree: { "src/": { layout: "open", children: {} } },
  });

describe.sequential("a command measure", () => {
  const writeAt = (file: string, source: string): void => {
    const at = path.join(commandRoot, file);
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, source);
  };
  const run = async (
    effect: (policy: Awaited<ReturnType<typeof loadPolicy>>) => Effect.Effect<void, CliFailure>,
  ) => {
    process.env.ARCHITECTURE_NOW = "2026-10-01T00:00:00Z";
    return capture(effect(await loadPolicy(commandRoot)));
  };
  const checkAt = async () => {
    const result = await run((policy) =>
      checkWith(policy, ["src"], {
        format: "json",
        manifestPath: path.join(commandRoot, "architecture.json"),
      }),
    );
    return { ...result, report: JSON.parse(result.output) as CheckReport };
  };

  beforeAll(() => {
    writeAt("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
    writeAt("src/index.ts", "export const x = 1;\n");
    writeAt("architecture.json", COMMAND_MANIFEST("echo 'bundle size: 812.5 kB'"));
  });

  afterAll(() => {
    rmSync(commandRoot, { force: true, recursive: true });
  });

  it("reads the number from the command's output, and records it on clear", async () => {
    const before = await checkAt();
    expect(before.report.campaigns[0]?.objectives[0]?.measure).toMatchObject({ value: 812.5 });
    const cleared = await run((policy) => objectives(policy, ["src"], ["clear"]));
    expect(cleared.output).toContain("bundle/size: 1 sector entered (scope); held to 812.5.");
    expect(Exit.isSuccess((await checkAt()).exit)).toBe(true);
  });

  it("holds a number that wobbles within its tolerance, and refuses a command that prints none", async () => {
    writeAt("architecture.json", COMMAND_MANIFEST("echo 'bundle size: 816 kB'"));
    expect(Exit.isSuccess((await checkAt()).exit)).toBe(true);
    writeAt("architecture.json", COMMAND_MANIFEST("echo 'no bundle'"));
    const { exit, failure, report } = await checkAt();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(report.campaigns[0]?.unmeasured).toEqual([{ objective: "size", sector: "scope" }]);
    expect(failure).toMatch(/a scalar objective measured no number/);
  });
});
