import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { check, cli, reportableOf } from "../cli.js";
import { exports, imports } from "../profile.js";
import { createRepo, type Repo } from "../repo.js";

// The first day. `init` writes the starter; the first external import is the
// first violation; the allowlist is where it is fixed. Then the ratchet: a
// planted violation is baselined, fixed, and its entry has to go — end to end,
// through the bin.

const CROSS_TIER = "import|src/imports|src/server.ts|lib/legacy.ts";

let repo: Repo;

beforeAll(() => {
  repo = createRepo({
    packages: { effect: ["Effect"] },
    files: {
      "src/server.ts": imports("./modules/auth/index.ts", "node:fs", "effect/Effect"),
      "src/modules/auth/index.ts": exports("login"),
      "lib/legacy.ts": exports("legacy"),
    },
  });
});

afterAll(() => {
  repo.dispose();
});

describe.sequential("adoption", () => {
  it("init writes a starter manifest and says what to run next", () => {
    const wrote = cli(repo, ["init"]);
    expect(wrote.code, wrote.stderr).toBe(0);
    expect(wrote.stdout).toContain("wrote architecture.yaml");
    expect(repo.exists("architecture.yaml")).toBe(true);
  });

  it("fails on the first external import, and passes once the package is allowed", () => {
    const first = check(repo, ["src"]);
    expect(first.code).toBe(1);
    expect(first.json.ok).toBe(false);
    expect(first.json.files).toBe(2);
    expect(first.json.violations).toHaveLength(1);
    expect(first.json.violations[0]).toMatchObject({
      kind: "import",
      ruleName: "src/imports",
      file: "src/server.ts",
      baselined: false,
    });
    expect(first.stdout.trim().startsWith("{")).toBe(true);

    repo.write(
      "architecture.yaml",
      repo.read("architecture.yaml").replace("external: []", "external: [effect]"),
    );

    const allowed = check(repo, ["src"]);
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(allowed.json.ok).toBe(true);
    expect(allowed.json.violations).toEqual([]);
  });

  it("reports a planted cross-tier import by fingerprint", () => {
    repo.write(
      "src/server.ts",
      imports("./modules/auth/index.ts", "node:fs", "effect/Effect", "../lib/legacy.ts"),
    );
    const planted = check(repo, ["src"]);
    expect(planted.code).toBe(1);
    expect(reportableOf(planted.json)).toEqual([CROSS_TIER]);
  });

  it("baselines it, and check passes with the entry marked baselined", () => {
    const wrote = cli(repo, ["baseline", "src"]);
    expect(wrote.code, wrote.stderr).toBe(0);
    expect(JSON.parse(repo.read(".architecture-baseline.json"))).toEqual({
      version: 1,
      entries: [CROSS_TIER],
    });

    const carried = check(repo, ["src"]);
    expect(carried.code, carried.stderr).toBe(0);
    expect(carried.json.ok).toBe(true);
    expect(carried.json.violations).toEqual([
      expect.objectContaining({ fingerprint: CROSS_TIER, baselined: true }),
    ]);
    expect(reportableOf(carried.json)).toEqual([]);
  });

  it("fails once the violation is fixed and its entry is stale, until the baseline is rewritten", () => {
    repo.write("src/server.ts", imports("./modules/auth/index.ts", "node:fs", "effect/Effect"));

    const stale = check(repo, ["src"]);
    expect(stale.code).toBe(1);
    expect(stale.json.ok).toBe(false);
    expect(stale.json.violations).toEqual([]);
    expect(stale.json.stale).toEqual([CROSS_TIER]);
    expect(stale.stderr).toContain("stale baseline entries");

    const pruned = cli(repo, ["baseline", "src"]);
    expect(pruned.code, pruned.stderr).toBe(0);
    expect(JSON.parse(repo.read(".architecture-baseline.json"))).toEqual({
      version: 1,
      entries: [],
    });

    const clean = check(repo, ["src"]);
    expect(clean.code, clean.stderr).toBe(0);
    expect(clean.json.ok).toBe(true);
    expect(clean.json.stale).toEqual([]);
  });
});
