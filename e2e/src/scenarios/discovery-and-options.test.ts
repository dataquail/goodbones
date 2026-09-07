import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { check, cli } from "../cli.js";
import { exports, imports } from "../profile.js";
import { createRepo, type Repo } from "../repo.js";

// How the bin finds its manifest and its files, and the two ways an
// unresolved edge is silenced.

const policy = (repo: Repo, resolve: Readonly<Record<string, unknown>> = {}) => ({
  resolve: { scopes: [repo.profile.scope], unresolved: "error", ...resolve },
  tree: {
    "src/": {
      message: "src/ may reach only itself.",
      layout: "open",
      imports: { message: "src/ may reach only itself.", allow: ["src/**"] },
      children: {},
    },
  },
});

let repo: Repo;

beforeAll(() => {
  repo = createRepo({
    files: {
      "src/server.ts": imports("./app.ts", "../lib/x.ts"),
      "src/app.ts": exports("app"),
      "lib/x.ts": exports("x"),
      "lib/y.ts": exports("y"),
    },
  });
});

afterAll(() => {
  repo.dispose();
});

describe.sequential("discovery and options", () => {
  it("points at init when there is no manifest", () => {
    const missing = cli(repo, ["check", "--json", "src"]);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("no architecture manifest found");
    expect(missing.stderr).toContain("architecture init");
  });

  it("walks the roots it is given, and a file as a root is that file", () => {
    repo.writeManifest(policy(repo));

    const src = check(repo, ["src"]);
    expect(src.json.files).toBe(2);
    expect(src.json.roots).toEqual(["src"]);

    const both = check(repo, ["src", "lib"]);
    expect(both.json.files).toBe(4);

    const one = check(repo, ["src/app.ts"]);
    expect(one.json.files).toBe(1);
    expect(one.json.violations).toEqual([]);
    expect(one.json.ok).toBe(true);
  });

  it("explain names the rule check reported for the file", () => {
    const { json } = check(repo, ["src"]);
    const [violation] = json.violations;
    expect(violation).toMatchObject({ ruleName: "src/imports", file: "src/server.ts" });

    const explained = cli(repo, ["explain", "src/server.ts"]);
    expect(explained.code, explained.stderr).toBe(0);
    expect(explained.stdout).toContain("src/server.ts");
    expect(explained.stdout).toContain("may import:");
    expect(explained.stdout).toContain("src/imports");
  });

  it("coverage prints the numbers check --json carries", () => {
    const { json } = check(repo, ["src", "lib"]);
    const printed = cli(repo, ["coverage", "src", "lib"]);
    expect(printed.code, printed.stderr).toBe(0);
    expect(printed.stdout).toContain(`${String(json.files)} files under src, lib`);
    for (const family of ["imports", "structure", "members", "surface", "graph"] as const) {
      const { covered, total } = json.coverage[family];
      expect(printed.stdout).toMatch(
        new RegExp(`${family}\\s+${String(covered)}/${String(total)}\\s`),
      );
    }
    expect(printed.stdout).toContain("unrestricted tiers: (none)");
  });

  it("reports an edge nothing resolves, unless the policy turns that off or names it", () => {
    repo.write("src/server.ts", imports("./app.ts", "nowhere-at-all", "also-nowhere"));

    const loud = check(repo, ["src"]);
    expect(loud.code).toBe(1);
    expect(loud.json.ok).toBe(false);
    expect(loud.json.violations).toEqual([]);
    expect(loud.json.unresolved.map((one) => one.specifier).sort()).toEqual([
      "also-nowhere",
      "nowhere-at-all",
    ]);
    expect(loud.json.unresolved[0]?.file).toBe("src/server.ts");

    repo.writeManifest(policy(repo, { unresolved: "off" }));
    const off = check(repo, ["src"]);
    expect(off.code, off.stderr).toBe(0);
    expect(off.json.ok).toBe(true);
    expect(off.json.unresolved).toEqual([]);

    repo.writeManifest(policy(repo, { ignoreUnresolved: ["^nowhere-"] }));
    const named = check(repo, ["src"]);
    expect(named.code).toBe(1);
    expect(named.json.unresolved.map((one) => one.specifier)).toEqual(["also-nowhere"]);
  });
});
