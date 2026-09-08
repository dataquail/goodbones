import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cli } from "../cli.js";
import { exports, imports } from "../profile.js";
import { createRepo, renderManifest, type Repo } from "../repo.js";

// The measurement, through the bin: a planted unused allowance shows up as
// slack, a file no family reaches as residue, a node no file is under as
// vacant, an entry shared through `use` is attributed to the fragment, the
// cycle count is the graph's, and `--against` measures the same tree against
// another manifest without failing on it.

// The shape `conformance --json` prints, as far as these scenarios read it.
// Declared here rather than imported, since this is the contract under test.
type ConformanceJson = {
  readonly version: 1;
  readonly ok: boolean;
  readonly files: number;
  readonly manifest: { readonly path: string; readonly sha256: string };
  readonly residue: {
    readonly files: ReadonlyArray<string>;
    readonly folders: ReadonlyArray<string>;
  };
  readonly vacant: ReadonlyArray<{ readonly node: string; readonly allowances: number }>;
  readonly violations: ReadonlyArray<{ readonly fingerprint: string; readonly baselined: boolean }>;
  readonly baseline: { readonly size: number };
  readonly cycles: number;
  readonly slack: ReadonlyArray<{
    readonly node: string;
    readonly kind: "allow" | "external";
    readonly entry: string;
    readonly fragment?: string;
    readonly of?: number;
  }>;
  readonly concentration: ReadonlyArray<{
    readonly fragment: string;
    readonly kind: "allow" | "external";
    readonly entry: string;
    readonly usedAt: number;
    readonly of: number;
  }>;
};

const conformance = (repo: Repo, argv: ReadonlyArray<string>) => {
  const result = cli(repo, ["conformance", "--json", ...argv]);
  let json: ConformanceJson;
  try {
    json = JSON.parse(result.stdout) as ConformanceJson;
  } catch (cause) {
    throw new Error(
      `conformance --json did not print one JSON object (exit ${String(result.code)}).\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\n${String(cause)}`,
    );
  }
  return { ...result, json };
};

const policy = (repo: Repo, allow: ReadonlyArray<string>): Readonly<Record<string, unknown>> => ({
  resolve: { scopes: [repo.profile.scope], unresolved: "off" },
  graph: {
    cycles: [{ name: "no-cycles", message: "These files import each other.", within: "src/**" }],
  },
  tree: {
    "src/": {
      message: "src/ reaches itself and the runtime.",
      layout: "open",
      imports: { message: "Not on the allowlist.", allow, external: ["effect"] },
      children: {},
    },
  },
});

let repo: Repo;

beforeAll(() => {
  repo = createRepo({
    packages: { effect: ["Effect"] },
    files: {
      "src/server.ts": imports("./a.ts", "node:fs", "effect/Effect", "../lib/legacy.ts"),
      "src/a.ts": imports("./b.ts"),
      "src/b.ts": imports("./a.ts"),
      "lib/legacy.ts": exports("legacy"),
      "scripts/build.ts": exports("build"),
    },
  });
  repo.writeManifest(policy(repo, ["src/**", "node:**"]));
});

afterAll(() => {
  repo.dispose();
});

describe.sequential("conformance", () => {
  it("never fails, and says what check would have done", () => {
    const measured = conformance(repo, ["src", "lib", "scripts"]);
    expect(measured.code, measured.stderr).toBe(0);
    expect(measured.json.version).toBe(1);
    expect(measured.json.files).toBe(5);
    // src/server.ts reaches lib/, which the allowlist refuses.
    expect(measured.json.ok).toBe(false);
    expect(measured.json.violations.map((one) => one.fingerprint)).toContain(
      "import|src/imports|src/server.ts|lib/legacy.ts",
    );
  });

  it("names the residue: the roots no family reaches", () => {
    const measured = conformance(repo, ["src", "lib", "scripts"]);
    expect(measured.json.residue).toEqual({
      files: ["lib/legacy.ts", "scripts/build.ts"],
      folders: ["lib", "scripts"],
    });
  });

  it("counts the cycle", () => {
    expect(conformance(repo, ["src"]).json.cycles).toBe(1);
  });

  it("reports no slack, no vacancy and no concentration while every allowance is used", () => {
    const measured = conformance(repo, ["src"]).json;
    expect(measured.slack).toEqual([]);
    expect(measured.vacant).toEqual([]);
    expect(measured.concentration).toEqual([]);
  });

  it("reports a planted unused allowance as slack, naming the node that wrote it", () => {
    repo.writeManifest(policy(repo, ["src/**", "node:**", "vendor/**"]));
    const planted = conformance(repo, ["src"]);
    expect(planted.code, planted.stderr).toBe(0);
    expect(planted.json.slack).toEqual([{ node: "src", kind: "allow", entry: "vendor/**" }]);

    // An unused external is slack of the other kind.
    repo.writeManifest({
      ...policy(repo, ["src/**", "node:**"]),
      tree: {
        "src/": {
          message: "src/ reaches itself and the runtime.",
          layout: "open",
          imports: { message: "m", allow: ["src/**", "node:**"], external: ["effect", "lodash"] },
          children: {},
        },
      },
    });
    expect(conformance(repo, ["src"]).json.slack).toEqual([
      { node: "src", kind: "external", entry: "lodash" },
    ]);
    repo.writeManifest(policy(repo, ["src/**", "node:**"]));
  });

  it("reports a node no walked file is under as vacant, and none of its allowances as slack", () => {
    const base = policy(repo, ["src/**", "node:**"]);
    const src = base.tree as Record<string, Record<string, unknown>>;
    repo.writeManifest({
      ...base,
      tree: {
        "src/": {
          ...src["src/"],
          children: {
            // A tier declared ahead of its first file.
            "ghost/": {
              layout: "open",
              imports: { message: "m", allow: ["src/**"], external: ["ghostpkg"] },
              children: {},
            },
          },
        },
      },
    });
    const measured = conformance(repo, ["src"]);
    expect(measured.code, measured.stderr).toBe(0);
    expect(measured.json.vacant).toEqual([{ node: "src/ghost", allowances: 2 }]);
    expect(measured.json.slack).toEqual([]);
    repo.writeManifest(policy(repo, ["src/**", "node:**"]));
  });

  it("attributes an entry shared through `use` to the fragment, once, and tells slack from concentration", () => {
    const base = policy(repo, ["src/**", "node:**"]);
    const src = base.tree as Record<string, Record<string, unknown>>;
    // Three file nodes write `use: shared`. server.ts imports effect; the others do
    // not; nothing imports lodash.
    repo.writeManifest({
      ...base,
      defs: { shared: { message: "m", allow: ["src/**"], external: ["effect", "lodash"] } },
      tree: {
        "src/": {
          ...src["src/"],
          children: {
            "server.ts": { imports: { use: "shared" } },
            "a.ts": { imports: { use: "shared" } },
            "b.ts": { imports: { use: "shared" } },
          },
        },
      },
    });
    const measured = conformance(repo, ["src"]);
    expect(measured.code, measured.stderr).toBe(0);
    expect(measured.json.vacant).toEqual([]);
    expect(measured.json.slack).toEqual([
      { node: "shared", kind: "external", entry: "lodash", fragment: "shared", of: 3 },
    ]);
    expect(measured.json.concentration).toEqual([
      { fragment: "shared", kind: "external", entry: "effect", usedAt: 1, of: 3 },
    ]);

    // The same document, as text: the fragment's line names how many nodes
    // were granted it, and the concentrated entry sits under its own heading.
    const text = cli(repo, ["conformance", "src"]);
    expect(text.stdout).toContain('  shared: external "lodash"  (via use, at 3 nodes)');
    expect(text.stdout).toContain(
      "concentrated: 1 allowance used at fewer than half the nodes granted",
    );
    expect(text.stdout).toContain('  shared: external "effect"  used at 1 of 3 nodes');
    repo.writeManifest(policy(repo, ["src/**", "node:**"]));
  });

  it("measures against a target manifest with --against, and names it", () => {
    repo.write(
      "target.yaml",
      renderManifest(policy(repo, ["src/**", "node:**", "lib/**"]), "yaml"),
    );
    const against = conformance(repo, ["--against", "target.yaml", "src", "lib"]);
    expect(against.code, against.stderr).toBe(0);
    expect(against.json.manifest.path).toBe("target.yaml");
    // The target admits the edge, so that violation is gone; the cycle stays.
    expect(against.json.violations.map((one) => one.fingerprint)).toEqual([
      "graph|no-cycles|src/a.ts|src/a.ts ↔ src/b.ts",
    ]);
    expect(against.json.residue.files).toEqual(["lib/legacy.ts"]);
    expect(against.json.slack).toEqual([]);

    // Only conformance takes it.
    const refused = cli(repo, ["check", "--against", "target.yaml", "src"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("conformance");
  });
});
