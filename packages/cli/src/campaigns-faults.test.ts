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
  removed: Array<string>;
  conceded: Array<string>;
  sentBack: { from: string | null; to: string | null; revoked: Array<string> } | null;
  ahead: Array<{
    objective: string;
    phase: string | null;
    before: number;
    after: number;
    onAhead: string;
  }>;
  onAhead: string;
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
  it("names work done ahead of the plan, and refuses it under onAhead: ratchet (O1)", async () => {
    // A read served before the backfill is attested: a served-phase holdout
    // paid down while billing waits at backfilled.
    write("src/billing/service.ts", SERVICE(['  proxy("a");', '  return localRoute("b");']));
    for (const flags of [[], ["--base", "HEAD"]]) {
      const { billing, exit, ok, text } = await nudge(...flags);
      expect(Exit.isSuccess(exit), text).toBe(true);
      expect(ok).toBe(true);
      expect(billing).toMatchObject({
        phase: { id: "backfilled" },
        verdict: "ok",
        onAhead: "advise",
        ahead: [{ objective: "routes-local", phase: "served", before: 2, after: 1 }],
      });
      expect(text).toContain(
        "ahead of plan: routes-local −1 belongs to served; billing is at backfilled (not yet attested) — onAhead: advise",
      );
    }
    const manifest = JSON.parse(MANIFEST) as { campaigns: { strangle: Record<string, unknown> } };
    manifest.campaigns.strangle.onAhead = "ratchet";
    write("architecture.json", JSON.stringify(manifest));
    for (const flags of [[], ["--base", "HEAD"]]) {
      const { billing, exit, ok, text } = await nudge(...flags);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(ok).toBe(false);
      expect(billing).toMatchObject({ verdict: "ahead", onAhead: "ratchet" });
      expect(text.trimEnd().endsWith("not ok")).toBe(true);
    }
    const failed = await capture(campaigns(await policyAt(), ["src"], ["status", "--changed"]));
    expect(failed.failure).toBe("the diff works ahead of a sector's phase under its onAhead");
    reset();
  });

  // A dozen nudges, each a git diff over a fresh evaluation: 4–6s on a CI
  // runner, past vitest's default 5s.
  it("weighs each objective paid ahead by its own onAhead, then the phase's, then the campaign's (R9)", async () => {
    // `no-models` counts what is left of a sector — a file per model — so
    // every phase's deletions pay it down ahead of `moved`.
    const withSettings = (
      campaign: Record<string, unknown>,
      objectives: Record<string, Record<string, unknown>> = {},
      phases: Record<string, Record<string, unknown>> = {},
    ): void => {
      const manifest = JSON.parse(MANIFEST) as {
        campaigns: {
          strangle: {
            objectives: Record<string, Record<string, unknown>>;
            phases: Array<Record<string, unknown> & { id: string }>;
          } & Record<string, unknown>;
        };
      };
      const strangle = manifest.campaigns.strangle;
      Object.assign(strangle, campaign);
      for (const [id, settings] of Object.entries(objectives))
        Object.assign(strangle.objectives[id] ?? {}, settings);
      for (const phase of strangle.phases) Object.assign(phase, phases[phase.id] ?? {});
      write("architecture.json", JSON.stringify(manifest));
    };
    const BOTH = [[], ["--base", "HEAD"]];
    unlinkSync(path.join(root, "src/billing/model.ts"));

    // Unset under a ratcheting campaign: refused, as O1 always was.
    withSettings({ onAhead: "ratchet" });
    for (const flags of BOTH) {
      const { billing, ok, text } = await nudge(...flags);
      expect(ok, text).toBe(false);
      expect(billing).toMatchObject({
        verdict: "ahead",
        onAhead: "ratchet",
        ahead: [{ objective: "no-models", phase: "moved", onAhead: "ratchet" }],
      });
    }

    // `ignore`: left out of the JSON and the text, and the verdict stands.
    withSettings({ onAhead: "ratchet" }, { "no-models": { onAhead: "ignore" } });
    for (const flags of BOTH) {
      const { billing, exit, ok, text } = await nudge(...flags);
      expect(Exit.isSuccess(exit), text).toBe(true);
      expect(ok).toBe(true);
      expect(billing).toMatchObject({ verdict: "ok", onAhead: "ratchet", ahead: [] });
      expect(text).not.toContain("ahead of plan");
    }

    // `advise` under a ratcheting campaign: listed, not refused.
    withSettings({ onAhead: "ratchet" }, { "no-models": { onAhead: "advise" } });
    for (const flags of BOTH) {
      const { billing, ok, text } = await nudge(...flags);
      expect(ok, text).toBe(true);
      expect(billing).toMatchObject({
        verdict: "ok",
        ahead: [{ objective: "no-models", onAhead: "advise" }],
      });
      expect(text).toContain(
        "ahead of plan: no-models −1 belongs to moved; billing is at backfilled (not yet attested) — onAhead: advise",
      );
    }

    // `ratchet` under an advising campaign: refused.
    withSettings({}, { "no-models": { onAhead: "ratchet" } });
    for (const flags of BOTH) {
      const { billing, ok } = await nudge(...flags);
      expect(ok).toBe(false);
      expect(billing).toMatchObject({ verdict: "ahead", onAhead: "advise" });
    }

    // A phase's word at the judged phase still reaches an objective with
    // none of its own, and an objective's own word beats it.
    withSettings({}, {}, { backfilled: { onAhead: "ratchet" } });
    for (const flags of BOTH) {
      const { billing, ok } = await nudge(...flags);
      expect(ok).toBe(false);
      expect(billing).toMatchObject({ verdict: "ahead", onAhead: "ratchet" });
    }
    withSettings(
      {},
      { "no-models": { onAhead: "ignore" } },
      { backfilled: { onAhead: "ratchet" } },
    );
    for (const flags of BOTH) {
      const { billing, ok } = await nudge(...flags);
      expect(ok).toBe(true);
      expect(billing).toMatchObject({ verdict: "ok", ahead: [] });
    }

    // Two paid ahead: each weighed by its own word, and the line names each
    // weight when they differ.
    write("src/billing/service.ts", SERVICE(['  proxy("a");', '  return localRoute("b");']));
    withSettings({ onAhead: "ratchet" }, { "no-models": { onAhead: "ignore" } });
    for (const flags of BOTH) {
      const { billing, ok } = await nudge(...flags);
      expect(ok).toBe(false);
      expect(billing).toMatchObject({
        verdict: "ahead",
        ahead: [{ objective: "routes-local", onAhead: "ratchet" }],
      });
      expect(billing.ahead).toHaveLength(1);
    }
    withSettings({ onAhead: "ratchet" }, { "no-models": { onAhead: "advise" } });
    for (const flags of BOTH) {
      const { billing, ok, text } = await nudge(...flags);
      expect(ok).toBe(false);
      expect(billing.verdict).toBe("ahead");
      expect(text).toContain(
        "ahead of plan: routes-local −1 belongs to served (ratchet) · no-models −1 belongs to moved (advise); billing is at backfilled (not yet attested)\n",
      );
    }
    reset();
  }, 30_000);

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

  it("refuses a note it would have to cut, and stores nothing (C3)", async () => {
    const recordAt = path.join(ledgerDir, "sectors", "billing.json");
    const before = readFileSync(recordAt, "utf8");
    const long = await capture(
      campaigns(await policyAt(), ["src"], ["note", "billing", "x".repeat(600), "--by", "me"]),
    );
    expect(Exit.isFailure(long.exit)).toBe(true);
    expect(long.failure).toContain("at most 500 characters, and this one is 600");
    expect(readFileSync(recordAt, "utf8")).toBe(before);
  });

  it("answers where one sector stands and what holds it, and refuses a sector given as a path (C4, R6)", async () => {
    const text = await capture(
      campaigns(await policyAt(), ["src"], ["status", "--sector", "billing"]),
    );
    expect(Exit.isSuccess(text.exit), text.failure).toBe(true);
    expect(text.output).toContain(
      "strangle · billing — phase served (4 of 6), reached served since 2026-10-02",
    );
    expect(text.output).toContain("  attested backfilled: 2026-10-02 by me — backfill ran");
    expect(text.output).toContain("  toward the next phase: routes-local 2");
    expect(text.output).toContain("  routes-local — 2 holdouts in window:");
    expect(text.output).toContain("    src/billing/service.ts:2  create");
    expect(text.output).toContain("    src/billing/service.ts:3  create");

    const json = await capture(
      campaigns(await policyAt(), ["src"], ["status", "--sector", "billing", "--json"]),
    );
    expect(JSON.parse(json.output)).toMatchObject({
      version: 1,
      sectors: [
        {
          campaign: "strangle",
          sector: "billing",
          phase: { id: "served", attested: false },
          reached: "served",
          // Earlier phases' windows stay open, and count nothing here.
          objectives: [
            { id: "no-reach", count: 0, holdouts: [] },
            { id: "writes-not-mirrored", count: 0, holdouts: [] },
            { id: "routes-local", count: 2, holdouts: [{ line: 2 }, { line: 3 }] },
          ],
        },
      ],
    });
    const unknown = await capture(
      campaigns(await policyAt(), ["src"], ["status", "--sector", "orders"]),
    );
    expect(unknown.failure).toContain("no campaign under src has a sector named orders");

    // The overview in JSON, bare or as `status` without `--changed`: a row
    // per sector.
    for (const argv of [["--json"], ["status", "--json"]]) {
      const overview = await capture(campaigns(await policyAt(), ["src"], argv));
      expect(Exit.isSuccess(overview.exit), overview.failure).toBe(true);
      expect(JSON.parse(overview.output)).toMatchObject({
        version: 1,
        campaigns: [{ id: "strangle", sectors: [{ name: "billing", phase: "served" }] }],
      });
    }
    // `status` in text without `--changed` is the overview, not a refusal,
    // and points at the per-sector view.
    const table = await capture(campaigns(await policyAt(), ["src"], ["status"]));
    expect(Exit.isSuccess(table.exit), table.failure).toBe(true);
    expect(table.output).toContain("1 campaign under src");
    expect(table.output).toContain(
      "phases: fenced 0 → mirrored 0 → backfilled (attested) 0 → served 1",
    );
    expect(table.output).toContain("architecture campaigns status --sector <sector> [--json]");
    // A sector's name where a path belongs is refused, naming `--sector`.
    const named = await capture(campaigns(await policyAt(), ["src"], ["billing"]));
    expect(Exit.isFailure(named.exit)).toBe(true);
    expect(named.failure).toContain("billing is not a path in the repository");
    expect(named.failure).toContain("`campaigns status --sector billing`");
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

  it("says when a concession sends a sector back, and revokes the attestation it crosses (R2)", async () => {
    // An unmirrored write at served, cleared, then conceded rather than fixed.
    const withWrite = SERVICE([
      '  rawWrite("subscriptions");',
      '  localRoute("a");',
      '  return localRoute("b");',
    ]);
    write("src/billing/service.ts", withWrite);
    await clear("2026-10-03T00:00:00Z");
    const conceded = await capture(
      objectives(
        await policyAt("2026-10-03T00:00:00Z"),
        ["src"],
        ["concede", "strangle/writes-not-mirrored", "--reason", "temporary", "--by", "me"],
      ),
    );
    expect(Exit.isSuccess(conceded.exit), conceded.failure).toBe(true);
    expect(conceded.output).toContain("this concession moves billing back served → mirrored.");
    expect(conceded.output).toContain(
      "It revokes billing's attestation of backfilled: what was attested no longer holds.",
    );
    const record = JSON.parse(
      readFileSync(path.join(ledgerDir, "sectors", "billing.json"), "utf8"),
    ) as { attested: Array<{ phase: string; revoked?: { by: string; reason: string } }> };
    expect(record.attested).toHaveLength(1);
    expect(record.attested[0]).toMatchObject({
      phase: "backfilled",
      revoked: { by: "me", reason: "conceded writes-not-mirrored: temporary" },
    });

    // The local nudge names the concession and the move, judged where HEAD's
    // ledgers placed billing.
    const { billing, ok, text } = await nudge();
    expect(ok, text).toBe(true);
    expect(billing).toMatchObject({
      phase: { id: "mirrored" },
      judged: { id: "served" },
      conceded: [expect.stringMatching(/^writes-not-mirrored: service\.ts#create#[0-9a-f]{8}$/)],
      sentBack: { from: "served", to: "mirrored", revoked: ["backfilled"] },
    });
    expect(text).toContain("conceded in the working tree, in the ledger: writes-not-mirrored:");
    expect(text).toContain(
      "the concession sends billing back served → mirrored, and revokes the attestation of backfilled",
    );

    // Paid down, billing stops at backfilled again: the backfill must be
    // attested anew before served counts.
    write("src/billing/service.ts", SERVICE(['  localRoute("a");', '  return localRoute("b");']));
    const view = await capture(
      campaigns(await policyAt(), ["src"], ["status", "--sector", "billing"]),
    );
    expect(view.output).toContain("strangle · billing — phase backfilled (3 of 6, attested)");
    expect(view.output).toContain(
      "(revoked 2026-10-03 by me: conceded writes-not-mirrored: temporary)",
    );
    const again = await capture(
      campaigns(
        await policyAt("2026-10-04T00:00:00Z"),
        ["src"],
        ["attest", "billing", "backfilled", "--reason", "backfill rerun", "--by", "me"],
      ),
    );
    expect(Exit.isSuccess(again.exit), again.failure).toBe(true);
    const after = await capture(
      campaigns(await policyAt(), ["src"], ["status", "--sector", "billing"]),
    );
    expect(after.output).toContain("strangle · billing — phase served (4 of 6)");
    reset();
  });

  it("keeps a holdout through a rename of the declaration around it (C6)", async () => {
    const before = sectorsOf("routes-local").billing?.holdouts ?? [];
    expect(before).toEqual([
      expect.stringMatching(/^service\.ts#create#[0-9a-f]{8}$/),
      expect.stringMatching(/^service\.ts#create#[0-9a-f]{8}$/),
    ]);
    write(
      "src/billing/service.ts",
      SERVICE(['  localRoute("a");', '  return localRoute("b");']).replace("create", "make"),
    );
    for (const flags of [[], ["--base", "HEAD"]]) {
      const { billing, ok, text } = await nudge(...flags);
      expect(ok, text).toBe(true);
      expect(billing).toMatchObject({ verdict: "ok", direction: "neutral", added: [] });
      expect(text).not.toContain("this diff:");
    }
    // No `concede` and no `clear`: the ledger already carries both.
    const { exit, failure, report } = await check();
    expect(Exit.isSuccess(exit), failure).toBe(true);
    expect(report.campaigns[0]?.new).toEqual([]);
    expect(report.campaigns[0]?.stale).toEqual([]);
    // `clear` rewrites them under the new name, as neither cleared nor new.
    const output = await clear("2026-10-03T00:00:00Z");
    expect(output).toContain("strangle/routes-local: 2 holdouts rewritten; 2 holdouts left.");
    expect(sectorsOf("routes-local").billing).toMatchObject({ cleared: 0 });
    expect(sectorsOf("routes-local").billing?.holdouts).toEqual(
      before.map((entry) => entry.replace("#create#", "#make#")),
    );
    reset();
  });

  it("shows the sector a diff that only deletes its files carries forward (C1)", async () => {
    // Served paid down: billing stands at moved, its model the last holdout.
    write("src/billing/service.ts", SERVICE(["  return proxy();"]));
    await clear("2026-10-04T00:00:00Z");
    commit("served");
    unlinkSync(path.join(root, "src/billing/model.ts"));
    for (const flags of [[], ["--base", "HEAD"]]) {
      const { billing, ok, text } = await nudge(...flags);
      expect(ok, text).toBe(true);
      expect(billing).toMatchObject({
        phase: { id: "settled" },
        judged: { id: "moved" },
        verdict: "ok",
        direction: "forward",
        added: [],
        removed: ["no-models: model.ts"],
        // Work done in order carries the sector into the phase it pays.
        ahead: [],
      });
      expect(text).toContain("this diff moves it from moved");
      expect(text).toContain("this diff: −no-models: model.ts  forward");
    }
    await clear("2026-10-05T00:00:00Z");
    commit("moved");
  });

  it("refuses a regression at the open last phase, held by the phase that named it (R1)", async () => {
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
