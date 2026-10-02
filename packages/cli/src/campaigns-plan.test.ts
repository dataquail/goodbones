import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { campaignFailuresOf, renderCampaignReports } from "@goodbones/campaigns";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadPolicyFromFile as loadPolicy } from "./config-loader.js";
import { check as checkWith, type CheckReport, type CliFailure, objectives } from "./run.js";

// A phase is what it asks and where it stands among the others, never its
// index: inserting a phase changes no other, moving one past another does,
// and a plan recorded when the hash still covered the index is read exactly
// until the next clear rewrites it. And what `clear` says of a sector it
// carries along the ladder.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../.tmp-cli-plan-tests");

type Phase = Record<string, unknown>;
const DOMAIN: Phase = { id: "domain", objectives: ["no-io"] };
const REPOSITORY: Phase = { id: "repository", objectives: ["no-knex"] };
const QUIET: Phase = { id: "quiet", objectives: ["no-console"] };
const LATER: Phase = { id: "later", intent: "Not written yet." };

// JSON, not a module: the module loader caches a `.mjs` manifest for the
// life of the process, and this suite edits the plan.
const MANIFEST = (phases: ReadonlyArray<Phase>): string =>
  JSON.stringify({
    resolve: {
      scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }],
      unresolved: "off",
    },
    campaigns: {
      ported: {
        why: "w",
        how: "h",
        scope: "src/**",
        perimeter: { marker: "**/context.ts" },
        phases,
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
        },
      },
    },
    tree: { "src/": { layout: "open", children: {} } },
  });

// The plan the engine wrote for `[DOMAIN, REPOSITORY, LATER]` while a
// phase's hash still covered its index — the file as it was written, not
// recomputed here, so this suite fails if a committed version 1 plan would
// ever read as changed.
const VERSION_1 = {
  version: 1,
  campaign: "ported",
  phases: [
    { id: "domain", hash: "7b5c6d97", defined: true, concessions: 0 },
    { id: "repository", hash: "f8fe3233", defined: true, concessions: 0 },
    { id: "later", hash: "9f4fdada", defined: false, concessions: 0 },
  ],
};

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

const planPath = path.join(root, ".architecture-campaigns/ported/plan.json");
const plan = (): { version: number; phases: Array<{ id: string }> } =>
  JSON.parse(readFileSync(planPath, "utf8")) as ReturnType<typeof plan>;

const NONE = { refined: [], changed: [], unreceipted: [] };

beforeAll(async () => {
  mkdirSync(root, { recursive: true });
  write("architecture.json", MANIFEST([DOMAIN, REPOSITORY, LATER]));
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  write("src/billing/context.ts", "");
  write("src/billing/service.ts", "export const read = () => readFileSync('x');\n");
  git("init", "-q");
  await clear("2026-10-01T00:00:00Z");
});

afterAll(() => {
  delete process.env.ARCHITECTURE_NOW;
  rmSync(root, { force: true, recursive: true });
});

describe.sequential("a phase's identity", () => {
  it("is written by clear as version 2, and a version 1 plan reads as unchanged", async () => {
    expect(plan().version).toBe(2);
    writeFileSync(planPath, JSON.stringify(VERSION_1, null, 2));
    const { exit, failure, report } = await check();
    expect(report.campaigns[0]?.plan).toEqual(NONE);
    expect(Exit.isSuccess(exit), failure).toBe(true);
  });

  it("does not change the phases after an insertion, against either version", async () => {
    // `no-console` gains a phase of its own, between the other two. The
    // version 1 plan on disk recorded `repository` at index 1 and `later` at
    // 2; they stand at 2 and 3 now, and ask what they asked.
    write("architecture.json", MANIFEST([DOMAIN, QUIET, REPOSITORY, LATER]));
    const against1 = await check();
    expect(against1.report.campaigns[0]?.plan).toEqual({ ...NONE, refined: ["quiet"] });
    expect(against1.failure).not.toContain("concession");

    await clear("2026-10-02T00:00:00Z");
    expect(plan()).toMatchObject({
      version: 2,
      phases: [{ id: "domain" }, { id: "quiet" }, { id: "repository" }, { id: "later" }],
    });
    const settled = await check();
    expect(settled.report.campaigns[0]?.plan).toEqual(NONE);
    expect(Exit.isSuccess(settled.exit), settled.failure).toBe(true);

    write(
      "architecture.json",
      MANIFEST([{ id: "first", attested: true }, DOMAIN, QUIET, REPOSITORY, LATER]),
    );
    expect((await check()).report.campaigns[0]?.plan).toEqual({ ...NONE, refined: ["first"] });
    write("architecture.json", MANIFEST([DOMAIN, QUIET, REPOSITORY, LATER]));
  });

  it("refuses a phase moved past another until it carries a concession", async () => {
    write("architecture.json", MANIFEST([QUIET, DOMAIN, REPOSITORY, LATER]));
    const moved = await check();
    const [which] = moved.report.campaigns[0]?.plan.unreceipted ?? [];
    expect(["domain", "quiet"]).toContain(which);
    expect(moved.report.campaigns[0]?.plan.changed).toEqual([which]);
    expect(moved.failure).toContain("changed without a concession");

    const receipt = {
      concessions: [{ reason: "quiet first: it blocks the port", at: "2026-10-03" }],
    };
    write(
      "architecture.json",
      MANIFEST(
        which === "quiet"
          ? [{ ...QUIET, ...receipt }, DOMAIN, REPOSITORY, LATER]
          : [QUIET, { ...DOMAIN, ...receipt }, REPOSITORY, LATER],
      ),
    );
    const receipted = await check();
    expect(receipted.report.campaigns[0]?.plan).toEqual({
      refined: [],
      changed: [which],
      unreceipted: [],
    });
    expect(receipted.failure).not.toContain("concession");
    write("architecture.json", MANIFEST([DOMAIN, QUIET, REPOSITORY, LATER]));
  });
});

describe.sequential("what clear says of a sector it moves", () => {
  it("names the window a sector entered, and the phases it passed without standing in them", async () => {
    // The read goes: billing leaves `domain`, has nothing for `quiet` or
    // `repository`, and lands in the open phase.
    write("src/billing/service.ts", "export const read = () => 1;\n");
    const cleared = await clear("2026-10-04T00:00:00Z");
    expect(cleared).toContain(
      "ported: billing moved domain → later, passing quiet, repository in the same clear: nothing there was ever counted for it.",
    );
    expect(Exit.isSuccess((await check()).exit)).toBe(true);
    // Nothing moved since: nothing said.
    expect(await clear("2026-10-05T00:00:00Z")).not.toContain("moved");
  });

  it("says which sector entered a window no ledger has recorded, and where it stands", async () => {
    write("src/orders/context.ts", "");
    write("src/orders/service.ts", "export const place = () => readFileSync('y');\n");
    await clear("2026-10-06T00:00:00Z");
    // orders pays down `domain` and stands at `repository`, with a knex call
    // its ledger has never been asked about.
    write("src/orders/service.ts", "export const place = () => knex('y');\n");
    const { report } = await check();
    expect(campaignFailuresOf(report.campaigns)).toContain(
      "campaign ported: orders (at repository) entered a window no ledger has recorded",
    );
    expect(campaignFailuresOf(report.campaigns)).not.toContain("campaign ported has no ledger");
    expect(renderCampaignReports(report.campaigns, []).join("\n")).toContain(
      "campaign ported: orders (at repository) entered a window since the last clear, and its objectives have no ledger entries for it yet.",
    );
    const cleared = await clear("2026-10-07T00:00:00Z");
    expect(cleared).toContain("ported: orders moved domain → repository, passing quiet");
  });
});
