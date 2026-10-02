import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadPolicyFromFile as loadPolicy } from "./config-loader.js";
import { campaigns, type CliFailure, objectives } from "./run.js";

// The nudge over the diffs a strangling makes, each of which it once got
// wrong: the paydown that carries a sector into the next phase, the last
// change of a phase that advises judged by the ratchet after it, and a rise
// conceded on the branch that the exact mode could not see. One sector,
// walked from `fenced` to `moved`.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../.tmp-cli-nudge-tests");

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
        { id: "fenced", objectives: ["no-role-checks"] },
        { id: "mirrored", onTouch: "advise", objectives: ["writes-not-mirrored"] },
        { id: "moved", objectives: ["no-routes", "has-nest"] },
        { id: "settled", intent: "What a settled module looks like is not written yet." },
      ],
      objectives: {
        "no-role-checks": {
          holdout: "match",
          match: { syntax: { pattern: "isAdmin($$$)" } },
          probes: { fires: [{ path: "src/a.ts", source: "isAdmin(user)" }] },
        },
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
        "has-nest": {
          how: "Rebuild the module on the new server.",
          holdout: "sector",
          sector: { has: { path: { file: "/nest/" } } },
        },
        // Named by no phase: in window everywhere.
        lines: { measure: { lines: true }, direction: "down", tolerance: 2 },
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

type Measure = {
  objective: string;
  before: number | null;
  after: number | null;
  recorded: number | null;
  back: boolean;
  conceded: boolean;
};

type Sector = {
  sector: string;
  phase: { id: string | null };
  judged: { id: string | null; index: number };
  onTouch: string;
  verdict: string;
  direction: string;
  added: Array<string>;
  removed: Array<string>;
  conceded: Array<string>;
  entered: Array<{ objective: string; count: number }>;
  measures: Array<Measure>;
  unmatchedOwns: Array<string>;
};

const nudge = async (...flags: ReadonlyArray<string>) => {
  const json = await capture(
    campaigns(await policyAt(), ["src"], ["status", "--changed", ...flags, "--json"]),
  );
  const text = await capture(
    campaigns(await policyAt(), ["src"], ["status", "--changed", ...flags]),
  );
  const parsed = JSON.parse(json.output) as { ok: boolean; sectors: Array<Sector> };
  const todo = parsed.sectors.find((one) => one.sector === "todo");
  if (todo === undefined) throw new Error("the diff did not touch the todo sector");
  return { exit: json.exit, ok: parsed.ok, todo, text: text.output };
};

const clear = async (now: string) => {
  const cleared = await capture(objectives(await policyAt(now), ["src"], ["clear"]));
  expect(Exit.isSuccess(cleared.exit), cleared.failure).toBe(true);
};

const commit = (message: string): void => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
};

const SERVICE = (body: ReadonlyArray<string>): string =>
  ["export function create(user) {", ...body, "}", ""].join("\n");

beforeAll(async () => {
  mkdirSync(root, { recursive: true });
  write("architecture.json", MANIFEST);
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  write(
    "src/todo/sector.ts",
    'export const sector = { name: "todo", owns: ["src/todo/**", "src/nest/todos/**"] };\n',
  );
  write(
    "src/todo/service.ts",
    SERVICE(['  if (isAdmin(user)) return rawWrite("a");', '  return rawWrite("b");']),
  );
  write("src/todo/routes.ts", 'export const routes = [route("/todos")];\n');
  write("src/user/sector.ts", "");
  write("src/user/service.ts", "export const allowed = (user) => isAdmin(user);\n");
  git("init", "-q");
  commit("fixture");
  await clear("2026-10-01T00:00:00Z");
  commit("first clear");
});

afterAll(() => {
  delete process.env.ARCHITECTURE_NOW;
  rmSync(root, { force: true, recursive: true });
});

describe.sequential("the nudge is judged by the phase the diff found the sector at", () => {
  it("counts a paydown that enters the next window as forward, not as growth", async () => {
    // The role check goes: todo derives to `mirrored`, whose two raw writes
    // no ledger has seen. They were there all along.
    write("src/todo/service.ts", SERVICE(['  rawWrite("a");', '  return rawWrite("b");']));
    for (const flags of [[], ["--base", "HEAD"]]) {
      const { exit, ok, text, todo } = await nudge(...flags);
      expect(Exit.isSuccess(exit), text).toBe(true);
      expect(ok).toBe(true);
      expect(todo).toMatchObject({
        phase: { id: "mirrored" },
        judged: { id: "fenced", index: 0 },
        onTouch: "ratchet",
        verdict: "ok",
        direction: "forward",
        added: [],
        entered: [{ objective: "writes-not-mirrored", count: 2 }],
      });
      expect(todo.removed).toEqual([
        expect.stringMatching(/^no-role-checks: service\.ts#create#[0-9a-f]{8}$/),
      ]);
      expect(text).toContain("todo — phase mirrored (2 of 4)");
      expect(text).toContain("this diff moves it from fenced");
      expect(text).toMatch(/this diff: −no-role-checks: \S+ {2}forward/);
      expect(text).toContain(
        "now counted: writes-not-mirrored 2 — in window from mirrored, not growth",
      );
      expect(text).toContain("onTouch: ratchet (of fenced) — ok");
    }
    await clear("2026-10-02T00:00:00Z");
    commit("fenced paid down");
  });

  it("judges the diff that completes an advising phase by that phase, not the ratchet after it", async () => {
    // The dual-write: the writes are mirrored, and the module grew past its
    // tolerance doing it. That lands todo in `moved`, which ratchets.
    write(
      "src/todo/service.ts",
      SERVICE([
        '  mirrored("a");',
        '  forward("a");',
        '  mirrored("b");',
        '  forward("b");',
        '  return audit("b");',
      ]),
    );
    const { exit, text, todo } = await nudge();
    expect(Exit.isSuccess(exit), text).toBe(true);
    expect(todo).toMatchObject({
      phase: { id: "moved" },
      judged: { id: "mirrored", index: 1 },
      onTouch: "advise",
      verdict: "ok",
      // Two holdouts gone and a number risen past its tolerance: one
      // direction for both, and the verdict is read off the same judgement.
      direction: "mixed",
      added: [],
      entered: [
        { objective: "no-routes", count: 1 },
        { objective: "has-nest", count: 1 },
      ],
      // The marker claims a folder nothing is in yet.
      unmatchedOwns: ["src/nest/todos/**"],
    });
    expect(todo.measures).toEqual([
      expect.objectContaining({ objective: "lines", before: 6, after: 9, recorded: 6, back: true }),
    ]);
    expect(text).toContain("lines: recorded 6 → now 9 (tolerance 2)  back");
    expect(text).toContain("onTouch: advise (of mirrored) — ok");
    // A sector's own holdout has no file: it is said of the sector, with the
    // glob its marker owns that nothing matches.
    expect(text).toContain(
      [
        "    of the sector as a whole:",
        "      has-nest: Rebuild the module on the new server.",
        "      (its marker owns `src/nest/todos/**`, which no file matches)",
      ].join("\n"),
    );
    expect(text).not.toContain("in the files you touched");
    const conceded = await capture(
      objectives(
        await policyAt("2026-10-03T00:00:00Z"),
        ["src"],
        ["concede", "strangle/lines", "--reason", "the dual-write", "--by", "me"],
      ),
    );
    expect(Exit.isSuccess(conceded.exit), conceded.failure).toBe(true);
    await clear("2026-10-03T00:00:00Z");
    commit("mirrored");
  });

  it("refuses a rise under a ratcheting phase, in both modes", async () => {
    write(
      "src/todo/service.ts",
      readFileSync(path.join(root, "src/todo/service.ts"), "utf8") +
        ["export const a = 1;", "export const b = 2;", "export const c = 3;", ""].join("\n"),
    );
    write("src/todo/more-routes.ts", 'export const more = [route("/todos/x")];\n');
    for (const flags of [[], ["--base", "HEAD"]]) {
      const { exit, ok, text, todo } = await nudge(...flags);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(ok).toBe(false);
      expect(todo).toMatchObject({
        phase: { id: "moved" },
        judged: { id: "moved" },
        onTouch: "ratchet",
        verdict: "back",
        direction: "back",
        added: ["no-routes: more-routes.ts"],
        conceded: [],
        entered: [],
      });
      expect(todo.measures).toEqual([
        expect.objectContaining({ before: 9, after: 13, recorded: 9, back: true, conceded: false }),
      ]);
      expect(text.trimEnd().endsWith("not ok")).toBe(true);
    }
  });

  it("lets a rise the branch conceded through in the exact mode, and names it", async () => {
    for (const objective of ["no-routes", "lines"]) {
      const conceded = await capture(
        objectives(
          await policyAt("2026-10-04T00:00:00Z"),
          ["src"],
          [
            "concede",
            `strangle/${objective}`,
            "--reason",
            "a route the cutover needs",
            "--by",
            "me",
          ],
        ),
      );
      expect(Exit.isSuccess(conceded.exit), conceded.failure).toBe(true);
    }
    // The ledger mode already read the ledger: it is quiet about both.
    const ledgerMode = await nudge();
    expect(ledgerMode.ok).toBe(true);
    expect(ledgerMode.todo).toMatchObject({ verdict: "ok", direction: "neutral", added: [] });
    // The exact mode compares the two trees, and the rise is still there —
    // receipted in the head's ledger, which is what it is held to.
    const { exit, ok, text, todo } = await nudge("--base", "HEAD");
    expect(Exit.isSuccess(exit), text).toBe(true);
    expect(ok).toBe(true);
    expect(todo).toMatchObject({
      verdict: "ok",
      direction: "neutral",
      added: [],
      conceded: ["no-routes: more-routes.ts"],
    });
    expect(todo.measures).toEqual([
      expect.objectContaining({ before: 9, after: 13, recorded: 13, back: false, conceded: true }),
    ]);
    expect(text).toContain("conceded on this branch, in the ledger: no-routes: more-routes.ts");
    expect(text).toContain("lines: 9 → 13 (recorded 13, tolerance 2)  conceded");
    expect(text).toContain("onTouch: ratchet — ok");
  });
});
