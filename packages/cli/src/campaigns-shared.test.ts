import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The shared: the files every sector shares — the destination's platform,
// the scaffolding a strangling leans on. They are on no phase and in no
// sector; an objective read over them is a prerequisite, which a phase
// naming it holds every sector to; and a number there is measured, not held.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../.tmp-cli-shared-tests");

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
      // The platform, and one file inside a sector's own folder.
      shared: ["src/platform/**", "src/**/proxy.ts"],
      phases: [
        { id: "rebuilt", objectives: ["no-role-checks", "has-authenticator"] },
        { id: "moved", objectives: ["no-routes"] },
      ],
      objectives: {
        "no-role-checks": {
          holdout: "match",
          match: { syntax: { pattern: "isAdmin($$$)" } },
          probes: { fires: [{ path: "src/a.ts", source: "isAdmin(user)" }] },
        },
        "has-authenticator": {
          how: "Build the user authenticator on the new server.",
          over: "shared",
          holdout: "sector",
          sector: { has: { path: { file: "authenticator" } } },
        },
        "no-routes": {
          holdout: "file",
          match: { content: { regex: "route\\(" } },
          probes: { fires: [{ path: "src/a.ts", source: "route('/x')" }] },
        },
        // Read over the shared files and named by no phase: its own standing rule.
        "no-raw-sql": {
          how: "Go through the query builder.",
          over: "shared",
          holdout: "match",
          match: { syntax: { pattern: "rawSql($$$)" } },
          probes: { fires: [{ path: "src/platform/a.ts", source: "rawSql('x')" }] },
        },
        // Named by no phase: measured in every sector, and on the shared files.
        lines: { measure: { lines: true }, direction: "down" },
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

type Sector = {
  sector: string;
  shared: boolean;
  phase: { id: string | null };
  onTouch: string;
  verdict: string;
  direction: string;
  toward: Record<string, number>;
  objectives: Array<{ id: string; shared: boolean }>;
  prerequisites: Array<{
    objective: string;
    count: number;
    phase: string | null;
    waiting: Array<string>;
  }>;
  added: Array<string>;
  removed: Array<string>;
  entered: Array<unknown>;
  measures: Array<{
    objective: string;
    before: number;
    after: number;
    back: boolean;
    grows: boolean;
  }>;
  belongsInSector: Array<string>;
};

const nudge = async () => {
  const json = await capture(
    campaigns(await policyAt(), ["src"], ["status", "--changed", "--json"]),
  );
  const text = await capture(campaigns(await policyAt(), ["src"], ["status", "--changed"]));
  const parsed = JSON.parse(json.output) as { ok: boolean; sectors: Array<Sector> };
  return {
    ok: parsed.ok,
    of: (name: string) => parsed.sectors.find((one) => one.sector === name),
    text: text.output,
  };
};

const ledgerDir = path.join(root, ".architecture-campaigns/strangle");
const sectorsOf = (objective: string): Record<string, Record<string, unknown>> =>
  (
    JSON.parse(readFileSync(path.join(ledgerDir, `${objective}.json`), "utf8")) as {
      sectors: Record<string, Record<string, unknown>>;
    }
  ).sectors;

const commit = (message: string): void => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
};

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  write("architecture.json", MANIFEST);
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  write("src/todo/sector.ts", "");
  write("src/todo/service.ts", "export const allowed = (user) => isAdmin(user);\n");
  write("src/todo/routes.ts", 'export const routes = [route("/todos")];\n');
  write("src/todo/proxy.ts", "export const proxy = () => rawSql('select 1');\n");
  write("src/user/sector.ts", "");
  write("src/user/service.ts", "export const allowed = (user) => isAdmin(user);\n");
  write("src/platform/db.ts", "export const db = 1;\n");
  git("init", "-q");
  commit("fixture");
});

afterAll(() => {
  delete process.env.ARCHITECTURE_NOW;
  rmSync(root, { force: true, recursive: true });
});

describe.sequential("the shared files", () => {
  it("are taken out before any sector is born, and are on no phase", async () => {
    const { report } = await check();
    const sectors = report.campaigns[0]?.sectors ?? [];
    // `proxy.ts` sits in todo's folder and is the shared files' all the same:
    // todo has three files, not four.
    expect(sectors.map((one) => [one.name, one.phase, one.files])).toEqual([
      ["todo", "rebuilt", 3],
      ["user", "rebuilt", 2],
      ["shared", null, 2],
    ]);
    const explained = await capture(explain(await policyAt(), "src/todo/proxy.ts", ["src"]));
    expect(explained.output).toContain(
      "campaign/strangle: sector shared — held by every sector, on no phase",
    );
    expect(explained.output).toContain("in window: has-authenticator, no-raw-sql ✗, lines");
  });

  it("ledgers a prerequisite once, under the shared files, and holds every sector at the phase naming it", async () => {
    const cleared = await clear("2026-10-01T00:00:00Z");
    expect(cleared).toContain(
      "strangle/has-authenticator: 1 sector entered (shared); 1 holdout left.",
    );
    expect(Object.keys(sectorsOf("has-authenticator"))).toEqual(["shared"]);
    expect(sectorsOf("has-authenticator").shared).toMatchObject({ holdouts: ["~"] });
    expect(Object.keys(sectorsOf("no-raw-sql"))).toEqual(["shared"]);
    // No sector's objective counts there, and the shared files have no record of
    // reaching a phase: it stands on none.
    expect(Object.keys(sectorsOf("no-role-checks")).sort()).toEqual(["todo", "user"]);
    expect(Object.keys(sectorsOf("lines")).sort()).toEqual(["shared", "todo", "user"]);
    expect(existsSync(path.join(ledgerDir, "sectors/shared.json"))).toBe(false);
    expect(Exit.isSuccess((await check()).exit)).toBe(true);
    commit("first clear");

    // todo pays its own debt for `rebuilt`, and stays there: the phase also
    // names the prerequisite, and the shared files have not met it.
    write("src/todo/service.ts", "export const allowed = () => true;\n");
    const { of, ok, text } = await nudge();
    expect(ok).toBe(true);
    expect(of("todo")).toMatchObject({
      shared: false,
      phase: { id: "rebuilt" },
      verdict: "ok",
      direction: "forward",
      toward: { "has-authenticator": 1 },
      objectives: [{ id: "has-authenticator", shared: true }],
      // Waited on, not scored: the prerequisite is the shared files'.
      added: [],
      entered: [],
    });
    expect(text).toContain("toward the next phase: has-authenticator 1");
    expect(text).toContain(
      "has-authenticator: a prerequisite — met on the shared files, and every sector at this phase waits on it",
    );
    await clear("2026-10-02T00:00:00Z");
    expect(Exit.isSuccess((await check()).exit)).toBe(true);
    commit("todo paid down");
  });

  it("prints what it holds in the status table and the snapshot", async () => {
    const status = await capture(campaigns(await policyAt(), ["src"], []));
    expect(status.output).toContain("phases: rebuilt 2 → moved 0  · shared 2 files");
    expect(status.output).toMatch(/has-authenticator\s+0%\s+1 left.*over the shared files/);
    const snapshot = await capture(
      conformance(await policyAt(), ["src"], {
        format: "json",
        manifestPath: path.join(root, "architecture.json"),
      }),
    );
    const [campaign] = (
      JSON.parse(snapshot.output) as {
        campaigns: Array<{
          progress: number;
          shared: unknown;
          sectors: Array<{ name: string; position: number }>;
          objectives: Array<{ id: string; over?: string }>;
        }>;
      }
    ).campaigns;
    expect(campaign?.shared).toEqual({ files: 2, holdouts: 2 });
    // The ladder counts the sectors, never the shared files. todo has paid one
    // of `rebuilt`'s two objectives; the other is the shared files' to pay.
    expect(campaign?.sectors).toEqual([
      expect.objectContaining({ name: "todo", position: 0.5 }),
      expect.objectContaining({ name: "user", position: 0 }),
    ]);
    expect(
      campaign?.objectives.filter((one) => one.over === "shared").map((one) => one.id),
    ).toEqual(["has-authenticator", "no-raw-sql"]);
  });

  it("reads work on the shared files as the campaign's, and moves every sector that waited on it", async () => {
    write(
      "src/platform/authenticator.ts",
      ["export const authenticate = () => {", "  return true;", "};", ""].join("\n"),
    );
    const { of, ok, text } = await nudge();
    expect(ok).toBe(true);
    expect(of("shared")).toMatchObject({
      shared: true,
      phase: { id: null },
      onTouch: "advise",
      verdict: "ok",
      direction: "forward",
      removed: ["has-authenticator: ~"],
      // A new file on the shared files belongs there: nothing asks for a sector.
      belongsInSector: [],
      prerequisites: [
        { objective: "has-authenticator", count: 0, phase: "rebuilt", waiting: ["user"] },
        { objective: "no-raw-sql", count: 1, phase: null, waiting: [] },
      ],
    });
    // The shared files hold no number: three lines more is a measurement.
    expect(of("shared")?.measures).toEqual([
      expect.objectContaining({
        objective: "lines",
        before: 2,
        after: 5,
        back: false,
        grows: true,
      }),
    ]);
    expect(text).toContain("shared — held by every sector, on no phase");
    expect(text).toContain("this diff: −has-authenticator: ~  forward");
    expect(text).toContain("lines: recorded 2 → now 5  measured, not held");
    expect(text).toContain("onTouch: advise — ok");
    expect(text).not.toContain("belongs in a sector");

    // `check` asks for a clear and nothing else; `clear` records the number
    // and says who moved.
    const before = await check();
    expect(before.report.campaigns[0]?.new.filter((one) => one.sector === "shared")).toEqual([]);
    const cleared = await clear("2026-10-03T00:00:00Z");
    expect(cleared).toContain("strangle/has-authenticator: 1 holdout cleared; 0 holdouts left.");
    expect(cleared).toContain("strangle/lines: 1 sector grown (shared 2 → 5, measured, not held)");
    expect(cleared).toContain("strangle: todo moved rebuilt → moved.");
    expect(sectorsOf("has-authenticator").shared).toMatchObject({ cleared: 1, holdouts: [] });
    // user still has its own role check to pay.
    expect(
      (await check()).report.campaigns[0]?.sectors.map((one) => [one.name, one.phase]),
    ).toEqual([
      ["todo", "moved"],
      ["user", "rebuilt"],
      ["shared", null],
    ]);
    expect(Exit.isSuccess((await check()).exit)).toBe(true);
    commit("authenticator");
  });

  it("still holds the shared files' own holdouts in check: advised is not unguarded", async () => {
    write("src/platform/db.ts", "export const db = rawSql('select 2');\n");
    const { of, ok } = await nudge();
    // The nudge advises on the shared files, always.
    expect(ok).toBe(true);
    expect(of("shared")).toMatchObject({ onTouch: "advise", verdict: "ok", direction: "back" });
    expect(of("shared")?.added).toEqual([
      expect.stringMatching(/^no-raw-sql: src\/platform\/db\.ts#db#[0-9a-f]{8}$/),
    ]);
    const { exit, report } = await check();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(report.campaigns[0]?.new.map((one) => `${one.objective}/${one.sector}`)).toEqual([
      "no-raw-sql/shared",
    ]);
  });
});
