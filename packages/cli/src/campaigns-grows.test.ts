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
  objectives,
} from "./run.js";

// A phase that `grows` a scalar: the dual-write of a strangling adds lines
// before it removes any, and the plan says so. For a sector standing in
// that phase a rise is neither `back` in the nudge nor growth `check` wants
// conceded — `clear` records it, with a receipt naming the phase — and the
// ratchet is back the moment the sector stands anywhere else.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../.tmp-cli-grows-tests");

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
      phases: [
        { id: "mirrored", objectives: ["writes-not-mirrored"], grows: ["lines"] },
        { id: "moved", objectives: ["no-routes"] },
      ],
      objectives: {
        "writes-not-mirrored": {
          holdout: "match",
          match: { syntax: { pattern: "rawWrite($$$)" } },
          probes: { fires: [{ path: "src/a.ts", source: "rawWrite('x')" }] },
        },
        "no-routes": {
          holdout: "file",
          match: { content: { regex: "route\\(" } },
          probes: { fires: [{ path: "src/a.ts", source: "route('/x')" }] },
        },
        lines: { measure: { lines: true }, direction: "down", tolerance: 1 },
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

type Measure = { objective: string; before: number; after: number; back: boolean; grows: boolean };

const nudge = async () => {
  const json = await capture(
    campaigns(await policyAt(), ["src"], ["status", "--changed", "--json"]),
  );
  const text = await capture(campaigns(await policyAt(), ["src"], ["status", "--changed"]));
  const parsed = JSON.parse(json.output) as {
    ok: boolean;
    sectors: Array<{ sector: string; verdict: string; onTouch: string; measures: Array<Measure> }>;
  };
  const todo = parsed.sectors.find((one) => one.sector === "todo");
  if (todo === undefined) throw new Error("the diff did not touch the todo sector");
  return { ok: parsed.ok, text: text.output, todo };
};

const ledger = (): {
  sectors: Record<string, { initial: number; recorded: number; improved: number }>;
  concessions: Array<Record<string, unknown>>;
} =>
  JSON.parse(
    readFileSync(path.join(root, ".architecture-campaigns/strangle/lines.json"), "utf8"),
  ) as ReturnType<typeof ledger>;

const commit = (message: string): void => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
};

const SERVICE = (body: ReadonlyArray<string>): string =>
  ["export function create() {", ...body, "}", ""].join("\n");

beforeAll(async () => {
  mkdirSync(root, { recursive: true });
  write("architecture.json", MANIFEST);
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  write("src/todo/sector.ts", "");
  write("src/todo/service.ts", SERVICE(['  rawWrite("a");', '  return rawWrite("b");']));
  write("src/todo/routes.ts", 'export const routes = [route("/todos")];\n');
  git("init", "-q");
  commit("fixture");
  await clear("2026-10-01T00:00:00Z");
  commit("first clear");
});

afterAll(() => {
  delete process.env.ARCHITECTURE_NOW;
  rmSync(root, { force: true, recursive: true });
});

describe.sequential("a phase that grows a scalar", () => {
  it("does not refuse the rise it expects: the nudge says so, and check asks for a clear", async () => {
    // One write mirrored, and the module three lines longer for it.
    write(
      "src/todo/service.ts",
      SERVICE(['  mirrored("a");', '  forward("a");', '  audit("a");', '  return rawWrite("b");']),
    );
    const { ok, text, todo } = await nudge();
    expect(ok).toBe(true);
    expect(todo).toMatchObject({ onTouch: "ratchet", verdict: "ok" });
    expect(todo.measures).toEqual([
      expect.objectContaining({
        objective: "lines",
        before: 5,
        after: 7,
        back: false,
        grows: true,
      }),
    ]);
    expect(text).toContain("lines: recorded 5 → now 7 (tolerance 1)  grows in mirrored");

    // The ledger is behind, not breached: the next step is `clear`, never
    // `concede`.
    const { exit, failure, report } = await check();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(report.campaigns[0]?.new).toEqual([]);
    expect(report.campaigns[0]?.stale).toContainEqual({
      objective: "lines",
      sector: "todo",
      entry: "measured 7, recorded 5 — a rise its phase grows",
    });
    expect(failure).toContain("stale ledger entries");
    expect(failure).not.toContain("unrecorded campaign growth");

    const cleared = await clear("2026-10-02T00:00:00Z");
    expect(cleared).toContain(
      "strangle/lines: 1 sector grown (todo 5 → 7, as mirrored expects); held to 7.",
    );
    // A receipt the plan wrote: the arithmetic holds with no hand in it.
    expect(ledger()).toMatchObject({
      sectors: { todo: { initial: 5, recorded: 7, improved: 0 } },
      concessions: [
        expect.objectContaining({
          sector: "todo",
          from: 5,
          to: 7,
          reason: "phase mirrored grows lines",
        }),
      ],
    });
    expect(Exit.isSuccess((await check()).exit)).toBe(true);
    commit("one write mirrored");
  });

  it("covers the change that completes the phase, judged where the ledgers found the sector", async () => {
    // The last write mirrored, three lines more: todo derives to `moved`,
    // which grows nothing. The rise happened under `mirrored`.
    write(
      "src/todo/service.ts",
      SERVICE([
        '  mirrored("a");',
        '  forward("a");',
        '  audit("a");',
        '  mirrored("b");',
        '  forward("b");',
        '  return audit("b");',
      ]),
    );
    const { ok, todo } = await nudge();
    expect(ok).toBe(true);
    expect(todo.measures).toEqual([
      expect.objectContaining({ before: 7, after: 9, back: false, grows: true }),
    ]);
    const { report } = await check();
    expect(report.campaigns[0]?.new.filter((one) => one.objective === "lines")).toEqual([]);
    const cleared = await clear("2026-10-03T00:00:00Z");
    expect(cleared).toContain("1 sector grown (todo 7 → 9, as mirrored expects)");
    expect(Exit.isSuccess((await check()).exit)).toBe(true);
    commit("mirrored");
  });

  it("ratchets again once the sector stands in a phase that grows nothing", async () => {
    write(
      "src/todo/service.ts",
      readFileSync(path.join(root, "src/todo/service.ts"), "utf8") +
        ["export const a = 1;", "export const b = 2;", ""].join("\n"),
    );
    const { ok, text, todo } = await nudge();
    expect(ok).toBe(false);
    expect(todo).toMatchObject({ verdict: "back" });
    expect(todo.measures).toEqual([
      expect.objectContaining({ before: 9, after: 11, back: true, grows: false }),
    ]);
    expect(text).toContain("lines: recorded 9 → now 11 (tolerance 1)  back");
    const { failure, report } = await check();
    expect(report.campaigns[0]?.new).toEqual([
      { objective: "lines", sector: "todo", entry: "measured 11, recorded 9" },
    ]);
    expect(failure).toContain("unrecorded campaign growth");
    // And `clear` leaves it where it is.
    await clear("2026-10-04T00:00:00Z");
    expect(ledger().sectors.todo?.recorded).toBe(9);
  });
});
