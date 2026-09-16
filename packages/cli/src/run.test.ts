import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { decodeSnapshot, type Snapshot } from "@goodbones/core";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadPolicyFromFile as loadPolicy } from "./config-loader.js";
import {
  campaigns,
  check as checkWith,
  type CheckReport,
  type CliFailure,
  collectFindings,
  conformance as conformanceWith,
  coverage,
  explain,
  facts,
  run,
  snapshotOf,
  writeBaseline,
} from "./run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../.tmp-cli-tests");

// Every fixture repository below keeps its manifest under the module name.
const check = (
  policy: Parameters<typeof checkWith>[0],
  roots: ReadonlyArray<string>,
  format: "text" | "json" = "text",
) =>
  checkWith(policy, roots, {
    format,
    manifestPath: path.join(policy.repoRoot, "architecture.config.mjs"),
  });

// A tiny repository with a policy of its own, so the CLI is exercised end to end
// — walker, parser, resolver, all four evaluators — without asserting anything
// about this repository's own code.
const MANIFEST = `export default {
  resolve: { scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }], unresolved: "off" },
  graph: {
    cycles: [{ name: "no-cycles", message: "These files import each other.", within: "lib/**" }],
  },
  exports: [
    {
      name: "no-factories",
      message: "A factory is built at a composition root.",
      module: "lib/**",
      symbols: ["makeBus"],
    },
  ],
  tree: {
    "src/": {
      message: "src/ admits a port and a view.",
      imports: {
        message: "src/ may reach only itself.",
        allow: ["src/**"],
      },
      children: {
        "*.repository.ts": {
          message: "A port needs its adapter.",
          requires: ["{base}-live.ts"],
          members: [
            {
              message: 'Port method "{name}" is not in the vocabulary.',
              subject: "members",
              declares: ["type", "interface"],
              in: "*RepositoryShape",
              allow: ["findOne"],
            },
          ],
        },
        "*.view.tsx": {
          surface: [{ message: "A view exports nothing named.", kinds: ["named"] }],
          members: [
            {
              message: "\`{name}\` puts state in the View.",
              subject: "calls",
              match: "use[A-Z]*",
              allow: ["useAtomValue"],
            },
          ],
        },
        // A tier declared ahead of its first file: no walked file is under it,
        // so its allowlist is vacant rather than slack.
        "ghost/": {
          layout: "open",
          imports: { message: "ghost/ may reach lib/.", allow: ["lib/**"] },
          children: {},
        },
      },
    },
  },
};
`;

const write = (file: string, source: string) => {
  const at = path.join(repoRoot, file);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, source);
};

beforeAll(() => {
  mkdirSync(repoRoot, { recursive: true });
  write("architecture.config.mjs", MANIFEST);
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  // imports: reaches outside `src/`.  exports: names a restricted factory.
  // members: a keyed finder, and a stateful hook.  structure: no `-live.ts`.
  write(
    "src/thing.repository.ts",
    'import { makeBus } from "../lib/bus.ts";\nexport type ThingRepositoryShape = { findOneById: () => void };\nexport const x = makeBus;\n',
  );
  write("src/thing.view.tsx", "export const V = () => useState(0);\n");
  // graph: two files in lib/ that import each other.
  write("lib/a.ts", 'import "./b.ts";\nexport const a = 1;\n');
  write("lib/b.ts", 'import "./a.ts";\nexport const b = 1;\n');
  write("lib/bus.ts", "export const makeBus = 1;\n");
  // residue: a root no family reaches. Walked only by the conformance tests.
  write("etc/stray.ts", "export const stray = 1;\n");
  // A target manifest for `--against`: what the tree does today, allowed.
  write("target.config.mjs", MANIFEST.replace('allow: ["src/**"]', 'allow: ["src/**", "lib/**"]'));
});

afterAll(() => {
  rmSync(repoRoot, { force: true, recursive: true });
});

describe("collectFindings", () => {
  it("reports every family — a gap in one is a family the CLI silently skips", async () => {
    const policy = await loadPolicy(repoRoot);
    const findings = collectFindings(policy, ["src", "lib"]);

    expect([...new Set(findings.violations.map((one) => one.kind))].sort()).toEqual([
      "export",
      "graph",
      "import",
      "member",
      "structure",
      "surface",
    ]);
  });

  it("names the rule behind each one", async () => {
    const policy = await loadPolicy(repoRoot);
    const names = collectFindings(policy, ["src", "lib"]).violations.map((one) => one.ruleName);

    expect(names).toEqual(
      expect.arrayContaining([
        "src/imports",
        "no-factories",
        "src/*.repository.ts/members-0",
        "src/*.view.tsx/members-0",
        "src/*.repository.ts/requires",
        "src/*.view.tsx/surface-0",
        "no-cycles",
      ]),
    );
  });

  it("counts the files it walked", async () => {
    const policy = await loadPolicy(repoRoot);
    expect(collectFindings(policy, ["src", "lib"]).files).toBe(5);
  });
});

// The suite runs tests concurrently (`sequence.concurrent`), and both of these
// are process-wide: one stdout descriptor, and one baseline file per fixture
// repository. The describes below are therefore sequential.
const captureReport = async (effect: Effect.Effect<void, CliFailure>) => {
  const lines: Array<string> = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const exit = await Effect.runPromiseExit(effect);
    return { exit, output: lines.join("") };
  } finally {
    process.stdout.write = original;
  }
};

describe.sequential("check", () => {
  it("names each violation and counts the files it walked", async () => {
    const { exit, output } = await captureReport(check(await loadPolicy(repoRoot), ["src", "lib"]));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(output).toContain("src/thing.repository.ts");
    expect(output).toContain("5 files, ");
  });

  it("prints one JSON object with --json, and nothing else on stdout", async () => {
    const { exit, output } = await captureReport(
      check(await loadPolicy(repoRoot), ["src", "lib"], "json"),
    );
    const report = JSON.parse(output) as CheckReport;

    expect(Exit.isFailure(exit)).toBe(true);
    expect(report.version).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.files).toBe(5);
    expect(report.roots).toEqual(["src", "lib"]);
    expect(report.manifest.path).toBe("architecture.config.mjs");
    expect(report.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.unresolved).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.adoption).toEqual({ unrestricted: [], partial: [] });
    // Every finding carries its fingerprint, which is the baseline's key.
    expect(report.violations).toContainEqual(
      expect.objectContaining({
        kind: "import",
        ruleName: "src/imports",
        file: "src/thing.repository.ts",
        subject: "lib/bus.ts",
        fingerprint: "import|src/imports|src/thing.repository.ts|lib/bus.ts",
        baselined: false,
      }),
    );
    expect([...new Set(report.violations.map((one) => one.kind))].sort()).toEqual([
      "export",
      "graph",
      "import",
      "member",
      "structure",
      "surface",
    ]);
    // Coverage is always carried, floors beside the families that state one.
    expect(report.coverage.imports).toEqual({ covered: 2, total: 5 });
    expect(Object.keys(report.coverage)).toEqual([
      "imports",
      "structure",
      "members",
      "surface",
      "graph",
    ]);
  });

  it("carries the floor in the JSON coverage, and is not ok under it", async () => {
    const policy = await loadPolicy(repoRoot);
    const floored = {
      ...policy,
      config: { ...policy.config, limits: { coverage: { imports: 0.5 } } },
    };
    const { output } = await captureReport(check(floored, ["src", "lib"], "json"));
    const report = JSON.parse(output) as CheckReport;

    expect(report.coverage.imports).toEqual({ covered: 2, total: 5, floor: 0.5 });
    expect(report.ok).toBe(false);
  });

  it("refuses to write a baseline when the policy declares nowhere to put one", async () => {
    const { exit } = await captureReport(writeBaseline(await loadPolicy(repoRoot), ["src"]));

    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe.sequential("explain", () => {
  it("prints the allowlist, the prohibitions, the folder rule, and the siblings owed", async () => {
    const { output } = await captureReport(
      explain(await loadPolicy(repoRoot), "src/thing.repository.ts"),
    );

    expect(output).toContain("may import:");
    expect(output).toContain("src/imports");
    expect(output).toContain("lives in:");
    expect(output).toContain("owes:");
    expect(output).toContain("src/thing.repository-live.ts");
  });

  it("names the rules of every other family that speak to the file", async () => {
    const view = (await captureReport(explain(await loadPolicy(repoRoot), "src/thing.view.tsx")))
      .output;
    expect(view).toContain("may not name (exports):");
    expect(view).toContain("no-factories");
    expect(view).toContain("vocabulary (members):");
    expect(view).toContain("src/*.view.tsx/members-0");
    expect(view).toContain("may export (surface):");
    expect(view).toContain("src/*.view.tsx/surface-0");
    expect(view).not.toContain("graph:");

    const bus = (await captureReport(explain(await loadPolicy(repoRoot), "lib/bus.ts"))).output;
    expect(bus).toContain("graph:");
    expect(bus).toContain("no-cycles");
    expect(bus).toContain("(cycles)");
  });

  it("says so when no tier above the file states an allowlist", async () => {
    const { output } = await captureReport(explain(await loadPolicy(repoRoot), "lib/bus.ts"));

    expect(output).toContain("no tier above this file states an allowlist");
  });
});

describe.sequential("coverage", () => {
  it("reports each family's reach and the adoption backlog", async () => {
    const { output } = await captureReport(coverage(await loadPolicy(repoRoot), ["src", "lib"]));

    expect(output).toContain("5 files under src, lib");
    // src/ has an allowlist; lib/ does not.
    expect(output).toMatch(/imports\s+2\/5\s+40%/);
    expect(output).toContain("unrestricted tiers: (none)");
  });

  it("fails check when a family is under the floor the policy states", async () => {
    const policy = await loadPolicy(repoRoot);
    const floored = {
      ...policy,
      config: { ...policy.config, limits: { coverage: { imports: 0.5 } } },
    };
    const { exit, output } = await captureReport(check(floored, ["src", "lib"]));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(output).toContain("coverage is below the floor");
    expect(output).toContain("imports: 40% covered, floor 50%");
  });
});

describe.sequential("facts", () => {
  it("prints every edge with its bindings, and every declared and called name", async () => {
    const { output } = await captureReport(
      facts(await loadPolicy(repoRoot), "src/thing.repository.ts"),
    );

    expect(output).toContain("edges:");
    expect(output).toContain("../lib/bus.ts");
    expect(output).toContain("named     makeBus");
    expect(output).toContain("members:");
    expect(output).toContain("ThingRepositoryShape.findOneById");
    expect(output).toContain("calls: (none)");
    expect(output).toContain("exports:");
    expect(output).toContain("named     x  (variable)");
  });

  it("emits the same facts as JSON", async () => {
    const { output } = await captureReport(
      facts(await loadPolicy(repoRoot), "src/thing.view.tsx", "json"),
    );

    const parsed = JSON.parse(output) as {
      file: string;
      edges: Array<unknown>;
      memberSites: Array<{ subject: string; name: string }>;
    };
    expect(parsed.file).toBe("src/thing.view.tsx");
    expect(parsed.edges).toEqual([]);
    expect(parsed.memberSites).toEqual([
      { file: "src/thing.view.tsx", subject: "calls", name: "useState" },
    ]);
  });

  it("fails on a file it cannot read", async () => {
    const { exit } = await captureReport(facts(await loadPolicy(repoRoot), "src/missing.ts"));

    expect(Exit.isFailure(exit)).toBe(true);
  });
});

// `run` is the dispatcher: its job is picking the command and the roots, which
// is what these assert. The reporting each command does is covered above —
// Vitest re-patches `process.stdout.write` across an await, so output written
// after `run`'s own async config load lands in its capture rather than ours.
describe.sequential("run", () => {
  it("defaults to check", async () => {
    const { exit } = await captureReport(run(repoRoot, ["check", "src", "lib"]));

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("routes explain", async () => {
    const { exit } = await captureReport(run(repoRoot, ["explain", "src/thing.repository.ts"]));

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("refuses explain without a file", async () => {
    const { exit } = await captureReport(run(repoRoot, ["explain"]));

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("routes check with --json anywhere in the arguments", async () => {
    const { exit, output } = await captureReport(run(repoRoot, ["check", "src", "--json", "lib"]));
    const report = JSON.parse(output) as CheckReport;

    expect(Exit.isFailure(exit)).toBe(true);
    expect(report.roots).toEqual(["src", "lib"]);
    expect(report.manifest.path).toBe("architecture.config.mjs");
  });

  it("routes coverage", async () => {
    const { exit } = await captureReport(run(repoRoot, ["coverage", "src", "lib"]));

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("routes facts, with --json anywhere in the arguments", async () => {
    const { exit } = await captureReport(run(repoRoot, ["facts", "--json", "src/thing.view.tsx"]));

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("refuses facts without a file", async () => {
    const { exit } = await captureReport(run(repoRoot, ["facts", "--json"]));

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("refuses a command it does not have", async () => {
    const { exit } = await captureReport(run(repoRoot, ["lint"]));

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("routes conformance, with --against naming another manifest", async () => {
    const { exit, output } = await captureReport(
      run(repoRoot, ["conformance", "src", "--json", "--against", "target.config.mjs", "lib"]),
    );
    const snapshot = JSON.parse(output) as Snapshot;

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(snapshot.roots).toEqual(["src", "lib"]);
    expect(snapshot.manifest.path).toBe("target.config.mjs");
    // The target allows the edge the repository's own manifest refuses.
    expect(snapshot.violations.map((one) => one.kind)).not.toContain("import");
  });

  it("refuses --against without a path, and on any command but conformance", async () => {
    const bare = await captureReport(run(repoRoot, ["conformance", "--against"]));
    expect(Exit.isFailure(bare.exit)).toBe(true);

    const onCheck = await captureReport(
      run(repoRoot, ["check", "--against", "target.config.mjs", "src"]),
    );
    expect(Exit.isFailure(onCheck.exit)).toBe(true);
    expect(JSON.stringify(onCheck.exit)).toContain("conformance");
  });
});

const ROOTS = ["src", "lib", "etc"];
const conformance = (
  policy: Parameters<typeof conformanceWith>[0],
  format: "text" | "json" = "text",
) =>
  conformanceWith(policy, ROOTS, {
    format,
    manifestPath: path.join(policy.repoRoot, "architecture.config.mjs"),
  });

describe.sequential("conformance", () => {
  it("emits the snapshot with --json, and the core's codec accepts it", async () => {
    const { exit, output } = await captureReport(conformance(await loadPolicy(repoRoot), "json"));
    const decoded = decodeSnapshot(JSON.parse(output));

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(Result.isSuccess(decoded), JSON.stringify(decoded)).toBe(true);
  });

  it("never fails: the document says what check would have done", async () => {
    const { exit, output } = await captureReport(conformance(await loadPolicy(repoRoot), "json"));

    expect(Exit.isSuccess(exit)).toBe(true);
    expect((JSON.parse(output) as Snapshot).ok).toBe(false);
  });

  it("grows the check report: same files, roots, manifest, coverage and adoption", async () => {
    const policy = await loadPolicy(repoRoot);
    const snapshot = snapshotOf(policy, ROOTS, path.join(repoRoot, "architecture.config.mjs"));

    expect(snapshot.version).toBe(1);
    expect(snapshot.files).toBe(6);
    expect(snapshot.roots).toEqual(ROOTS);
    expect(snapshot.manifest.path).toBe("architecture.config.mjs");
    expect(snapshot.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.coverage.imports).toEqual({ covered: 2, total: 6 });
    expect(snapshot.adoption).toEqual({ unrestricted: [], partial: [] });
    expect(snapshot.unresolved).toEqual([]);
    expect(snapshot.stale).toEqual([]);
    expect(snapshot.baseline).toEqual({ size: 0 });
  });

  it("names the residue: the file and the folder no family reaches", async () => {
    const snapshot = snapshotOf(
      await loadPolicy(repoRoot),
      ROOTS,
      path.join(repoRoot, "architecture.config.mjs"),
    );

    expect(snapshot.residue).toEqual({ files: ["etc/stray.ts"], folders: ["etc"] });
  });

  it("names the vacant node: an allowlist that selects no file, and leaves it out of the slack", async () => {
    const snapshot = snapshotOf(
      await loadPolicy(repoRoot),
      ROOTS,
      path.join(repoRoot, "architecture.config.mjs"),
    );

    expect(snapshot.vacant).toEqual([{ node: "src/ghost", allowances: 1 }]);
    expect(snapshot.slack).not.toContainEqual(expect.objectContaining({ node: "src/ghost" }));
  });

  it("reports an allowance nothing imports through as slack", async () => {
    const snapshot = snapshotOf(
      await loadPolicy(repoRoot),
      ROOTS,
      path.join(repoRoot, "architecture.config.mjs"),
    );

    // src/ allows `src/**`, and no file in src/ imports another.
    expect(snapshot.slack).toEqual([{ node: "src", kind: "allow", entry: "src/**" }]);
    expect(snapshot.concentration).toEqual([]);
  });

  it("drops the slack once an import uses the allowance", async () => {
    const policy = await loadPolicy(repoRoot);
    const target = snapshotOf(policy, ROOTS, path.join(repoRoot, "target.config.mjs"));
    expect(target.slack).toEqual([{ node: "src", kind: "allow", entry: "src/**" }]);

    const against = await loadPolicy(repoRoot, "target.config.mjs");
    const used = snapshotOf(against, ROOTS, path.join(repoRoot, "target.config.mjs"));
    // `lib/**` was added to the target and src/thing.repository.ts reaches lib/bus.ts.
    expect(used.slack).toEqual([{ node: "src", kind: "allow", entry: "src/**" }]);
    expect(used.violations.map((one) => one.kind)).not.toContain("import");
  });

  it("counts every cycle in the graph, in a rule's scope or not", async () => {
    const snapshot = snapshotOf(
      await loadPolicy(repoRoot),
      ROOTS,
      path.join(repoRoot, "architecture.config.mjs"),
    );

    expect(snapshot.cycles).toBe(1);
  });

  it("orders violations by the height of their target, leaves first", async () => {
    const snapshot = snapshotOf(
      await loadPolicy(repoRoot),
      ROOTS,
      path.join(repoRoot, "architecture.config.mjs"),
    );
    const fingerprints = snapshot.violations.map((one) => one.fingerprint);
    const at = (prefix: string): number => {
      const index = fingerprints.findIndex((one) => one.startsWith(prefix));
      if (index === -1) throw new Error(`no violation ${prefix} in ${fingerprints.join("\n")}`);
      return index;
    };

    // The edge to lib/bus.ts, which imports nothing, is nearest the ground;
    // the missing sibling is about thing.repository.ts itself, which stands
    // one above bus.ts — so the edge is listed first.
    expect(at("import|src/imports|src/thing.repository.ts|lib/bus.ts")).toBeLessThan(
      at("structure|src/*.repository.ts/requires|src/thing.repository.ts"),
    );
    // Same height, fingerprint order — so the list is the same on every run.
    const again = snapshotOf(
      await loadPolicy(repoRoot),
      ROOTS,
      path.join(repoRoot, "architecture.config.mjs"),
    );
    expect(again.violations.map((one) => one.fingerprint)).toEqual(fingerprints);
  });

  it("renders every section as text", async () => {
    const { exit, output } = await captureReport(conformance(await loadPolicy(repoRoot)));

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(output).toContain("6 files under src, lib, etc, against architecture.config.mjs");
    expect(output).toContain("coverage");
    expect(output).toContain("residue: 1 file no family reaches, 1 folder wholly");
    expect(output).toContain("  etc/");
    expect(output).toContain("vacant: 1 node selects no file");
    expect(output).toContain("  src/ghost  1 allowance");
    expect(output).toContain("violations: ");
    expect(output).toContain("nearest the ground first");
    expect(output).toContain("slack: 1 allowance nothing imports through");
    expect(output).toContain('  src: allow "src/**"');
    expect(output).toContain("cycles: 1");
    expect(output).toContain("baseline: 0 entries");
  });
});

// The baseline is one mutable file, so its tests get a repository of their own
// rather than racing the ones above for the same path.
const baselineRoot = path.resolve(here, "../../../.tmp-cli-baseline-tests");
const baselineAt = path.join(baselineRoot, ".architecture-baseline.json");

const writeIn = (root: string, file: string, source: string) => {
  const at = path.join(root, file);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, source);
};

beforeAll(() => {
  mkdirSync(baselineRoot, { recursive: true });
  writeIn(
    baselineRoot,
    "architecture.config.mjs",
    MANIFEST.replace("tree: {", 'baseline: ".architecture-baseline.json",\n  tree: {'),
  );
  writeIn(baselineRoot, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  writeIn(baselineRoot, "src/thing.repository.ts", 'import { makeBus } from "../lib/bus.ts";\n');
  writeIn(baselineRoot, "lib/bus.ts", "export const makeBus = 1;\n");
});

afterAll(() => {
  rmSync(baselineRoot, { force: true, recursive: true });
});

describe.sequential("baseline", () => {
  it("records every violation as a fingerprint", async () => {
    const { exit } = await captureReport(
      writeBaseline(await loadPolicy(baselineRoot), ["src", "lib"]),
    );
    const written = JSON.parse(readFileSync(baselineAt, "utf8")) as { entries: Array<string> };

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(written.entries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("import|src/imports|src/thing.repository.ts"),
      ]),
    );
  });

  it("carries what it recorded, and says how many", async () => {
    const { exit, output } = await captureReport(
      check(await loadPolicy(baselineRoot), ["src", "lib"]),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(output).toContain("carried by the baseline");
  });

  it("is ok in JSON with every finding marked baselined", async () => {
    const { exit, output } = await captureReport(
      check(await loadPolicy(baselineRoot), ["src", "lib"], "json"),
    );
    const report = JSON.parse(output) as CheckReport;

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.violations.every((one) => one.baselined)).toBe(true);
    expect(report.stale).toEqual([]);
  });

  // The ratchet's teeth. A baseline that keeps entries the code no longer
  // produces stops being a record of debt and becomes a place to hide.
  it("fails on an entry that no longer fires, and says how to prune it", async () => {
    writeFileSync(
      baselineAt,
      JSON.stringify({ version: 1, entries: ["import|src/imports|src/gone.ts|lib/bus.ts"] }),
    );
    const { exit, output } = await captureReport(
      check(await loadPolicy(baselineRoot), ["src", "lib"]),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(output).toContain("no longer fire");
    expect(output).toContain("architecture baseline");
  });

  it("lists the stale entry under `stale` in JSON, and is not ok", async () => {
    const { exit, output } = await captureReport(
      check(await loadPolicy(baselineRoot), ["src", "lib"], "json"),
    );
    const report = JSON.parse(output) as CheckReport;

    expect(Exit.isFailure(exit)).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.stale).toEqual(["import|src/imports|src/gone.ts|lib/bus.ts"]);
  });
});

describe.sequential("resolution and a damaged baseline", () => {
  it("reports an unresolvable specifier when the policy asks it to", async () => {
    const root = path.resolve(here, "../../../.tmp-cli-unresolved");
    writeIn(
      root,
      "architecture.config.mjs",
      MANIFEST.replace('unresolved: "off"', 'unresolved: "error"'),
    );
    writeIn(root, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
    writeIn(root, "src/thing.repository.ts", 'import { x } from "nowhere-at-all";\n');

    const { exit, output } = await captureReport(check(await loadPolicy(root), ["src"]));
    rmSync(root, { force: true, recursive: true });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(output).toContain("unresolved:");
  });

  // A baseline nobody can parse carries nothing, which is the safe direction:
  // every violation reports.
  it("carries nothing when the baseline file is not readable as JSON", async () => {
    writeFileSync(baselineAt, "{ not json");
    const { exit, output } = await captureReport(
      check(await loadPolicy(baselineRoot), ["src", "lib"]),
    );
    rmSync(baselineAt, { force: true });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(output).not.toContain("carried by the baseline");
  });

  it("routes the baseline command", async () => {
    const { exit } = await captureReport(run(baselineRoot, ["baseline", "src", "lib"]));
    rmSync(baselineAt, { force: true });

    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

// A repository running two campaigns: a `file` one over a path shape, and a
// `match` one through the real ast-grep matcher. Driven through the ledger's
// whole life: no ledger, init, a fix, the stale failure, prune, a regression,
// the unrecorded-growth failure, allow, and what conformance says.
const campaignRoot = path.resolve(here, "../../../.tmp-cli-campaign-tests");
const ledgerAt = (id: string) => path.join(campaignRoot, ".architecture-campaigns", `${id}.json`);

const CAMPAIGN_MANIFEST = `export default {
  resolve: { scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }], unresolved: "off" },
  campaigns: [
    {
      id: "legacy-to-modern",
      why: "Nothing new is written under legacy/, and what is there moves out.",
      how: "Move the module under src/modern/ and update its importers.",
      owner: "@team/platform",
      scope: ["src/**"],
      unit: "file",
      detect: { path: { file: "^src/legacy/" } },
      probes: { fires: [{ path: "src/legacy/util.ts" }], ignores: [{ path: "src/util.ts" }] },
      staleAfter: "14d",
      onComplete: "remove",
    },
    {
      id: "no-throw",
      why: "Errors are returned, not thrown.",
      how: "Return a Result instead of throwing.",
      scope: ["src/**"],
      unit: "match",
      detect: { syntax: { pattern: "throw new Error($$$)" } },
      probes: {
        fires: [{ path: "src/a.ts", source: "function f() { throw new Error('x'); }" }],
        ignores: [{ path: "src/b.ts", source: "function f() { return 1; }" }],
      },
      staleAfter: "30d",
    },
  ],
  tree: { "src/": { layout: "open", children: {} } },
};
`;

const campaignPolicy = (now?: string) => {
  if (now !== undefined) process.env.ARCHITECTURE_NOW = now;
  else delete process.env.ARCHITECTURE_NOW;
  return loadPolicy(campaignRoot);
};

const checkCampaigns = async (format: "text" | "json" = "text") =>
  captureReport(check(await campaignPolicy(), ["src"], format));

beforeAll(() => {
  mkdirSync(campaignRoot, { recursive: true });
  writeIn(campaignRoot, "architecture.config.mjs", CAMPAIGN_MANIFEST);
  writeIn(campaignRoot, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  writeIn(campaignRoot, "src/legacy/one.ts", "export const one = 1;\n");
  writeIn(campaignRoot, "src/legacy/two.ts", "export const two = 2;\n");
  writeIn(campaignRoot, "src/fine.ts", "export const fine = 1;\n");
  writeIn(
    campaignRoot,
    "src/thrower.ts",
    'export function parse(x: string) { if (x === "") throw new Error("empty"); return x; }\n',
  );
});

afterAll(() => {
  delete process.env.ARCHITECTURE_NOW;
  rmSync(campaignRoot, { force: true, recursive: true });
});

describe.sequential("campaigns", () => {
  it("fails check on a campaign with hits and no ledger, and says how to init it", async () => {
    const { exit, output } = await checkCampaigns();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(output).toContain("campaign legacy-to-modern: 2 hits and no ledger");
    expect(output).toContain("architecture campaigns init legacy-to-modern");
    const { output: json } = await checkCampaigns("json");
    const report = JSON.parse(json) as CheckReport;
    expect(report.ok).toBe(false);
    expect(report.campaigns.map((one) => [one.id, one.count, one.missingLedger])).toEqual([
      ["legacy-to-modern", 2, true],
      ["no-throw", 1, true],
    ]);
    expect(
      report.violations.filter((one) => one.kind === "campaign").map((one) => one.fingerprint),
    ).toEqual([
      "campaign|campaign/legacy-to-modern|src/legacy/one.ts|",
      "campaign|campaign/legacy-to-modern|src/legacy/two.ts|",
      expect.stringMatching(/^campaign\|campaign\/no-throw\|src\/thrower\.ts\|parse#[0-9a-f]{8}$/),
    ]);
  });

  it("init writes a ledger from what fires today, and refuses to overwrite it", async () => {
    const policy = await campaignPolicy("2026-09-01T00:00:00Z");
    const first = await captureReport(campaigns(policy, ["src"], ["init", "legacy-to-modern"]));
    expect(Exit.isSuccess(first.exit)).toBe(true);
    expect(first.output).toContain(
      "2 hits recorded in .architecture-campaigns/legacy-to-modern.json",
    );
    const ledger = JSON.parse(readFileSync(ledgerAt("legacy-to-modern"), "utf8")) as {
      initial: number;
      entries: Array<string>;
      created: string;
    };
    expect(ledger.initial).toBe(2);
    expect(ledger.entries).toEqual(["src/legacy/one.ts", "src/legacy/two.ts"]);
    expect(ledger.created).toBe("2026-09-01T00:00:00.000Z");

    const again = await captureReport(
      campaigns(await campaignPolicy(), ["src"], ["init", "legacy-to-modern"]),
    );
    expect(Exit.isFailure(again.exit)).toBe(true);
    await captureReport(
      campaigns(await campaignPolicy("2026-09-01T00:00:00Z"), ["src"], ["init", "no-throw"]),
    );
  });

  it("is ok once every hit is ledgered, with each marked ledgered in JSON", async () => {
    const { exit, output } = await checkCampaigns("json");
    const report = JSON.parse(output) as CheckReport;
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(report.ok).toBe(true);
    expect(
      report.violations.filter((one) => one.kind === "campaign").every((one) => one.ledgered),
    ).toBe(true);
  });

  it("fails on a fixed entry until it is pruned, and prune stamps progress", async () => {
    rmSync(path.join(campaignRoot, "src/legacy/two.ts"));
    const { exit, output } = await checkCampaigns();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(output).toContain("campaign legacy-to-modern: 1 ledger entry no longer fire");
    expect(output).toContain("architecture campaigns prune legacy-to-modern");

    const pruned = await captureReport(
      campaigns(await campaignPolicy("2026-09-10T00:00:00Z"), ["src"], ["prune"]),
    );
    expect(Exit.isSuccess(pruned.exit)).toBe(true);
    expect(pruned.output).toContain("legacy-to-modern: 1 entry pruned; 1 entry left.");
    expect(pruned.output).toContain("no-throw: nothing to prune.");
    const ledger = JSON.parse(readFileSync(ledgerAt("legacy-to-modern"), "utf8")) as {
      fixed: number;
      lastProgress: string;
      entries: Array<string>;
    };
    expect(ledger.fixed).toBe(1);
    expect(ledger.lastProgress).toBe("2026-09-10T00:00:00.000Z");
    expect(ledger.entries).toEqual(["src/legacy/one.ts"]);
    expect(Exit.isSuccess((await checkCampaigns()).exit)).toBe(true);
  });

  it("treats an edit inside the anchored declaration as the same match entry", async () => {
    writeIn(
      campaignRoot,
      "src/thrower.ts",
      'export function parse(x: string) {\n  if (x === "") throw new Error("nothing given");\n  return x;\n}\n',
    );
    const { exit, output } = await checkCampaigns("json");
    const report = JSON.parse(output) as CheckReport;
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(report.campaigns.find((one) => one.id === "no-throw")?.drifted).toBe(1);
    const pruned = await captureReport(
      campaigns(await campaignPolicy(), ["src"], ["prune", "no-throw"]),
    );
    expect(pruned.output).toContain("no-throw: 0 entries pruned, 1 entry rewritten; 1 entry left.");
  });

  it("fails on unrecorded growth, and allow records the regression with a reason and an author", async () => {
    writeIn(campaignRoot, "src/legacy/three.ts", "export const three = 3;\n");
    const { exit, output } = await checkCampaigns();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(output).toContain("campaign legacy-to-modern: 1 new hit the ledger does not carry");
    expect(output).toContain("Move the module under src/modern/ and update its importers.");
    expect(output).toContain('architecture campaigns allow legacy-to-modern --reason "<why>"');

    const refused = await captureReport(
      campaigns(await campaignPolicy(), ["src"], ["allow", "legacy-to-modern"]),
    );
    expect(Exit.isFailure(refused.exit)).toBe(true);

    const allowedRun = await captureReport(
      campaigns(
        await campaignPolicy("2026-09-12T00:00:00Z"),
        ["src"],
        [
          "allow",
          "legacy-to-modern",
          "--reason",
          "vendored until v4",
          "--by",
          "someone@example.com",
        ],
      ),
    );
    expect(Exit.isSuccess(allowedRun.exit)).toBe(true);
    expect(allowedRun.output).toContain(
      "legacy-to-modern: 1 entry allowed, recorded as a regression by someone@example.com",
    );
    const ledger = JSON.parse(readFileSync(ledgerAt("legacy-to-modern"), "utf8")) as {
      regressions: Array<{ delta: number; reason: string; by: string; entries: Array<string> }>;
      entries: Array<string>;
    };
    expect(ledger.regressions).toEqual([
      {
        at: "2026-09-12T00:00:00.000Z",
        by: "someone@example.com",
        delta: 1,
        reason: "vendored until v4",
        entries: ["src/legacy/three.ts"],
      },
    ]);
    expect(ledger.entries).toEqual(["src/legacy/one.ts", "src/legacy/three.ts"]);
    expect(Exit.isSuccess((await checkCampaigns()).exit)).toBe(true);
  });

  it("fails when the ledger does not add up", async () => {
    const at = ledgerAt("legacy-to-modern");
    const ledger = JSON.parse(readFileSync(at, "utf8")) as { entries: Array<string> };
    writeIn(campaignRoot, "src/legacy/four.ts", "export const four = 4;\n");
    writeFileSync(
      at,
      JSON.stringify({ ...ledger, entries: [...ledger.entries, "src/legacy/four.ts"] }),
    );
    const { exit, output } = await checkCampaigns();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(output).toContain("the ledger does not add up");
    rmSync(path.join(campaignRoot, "src/legacy/four.ts"));
    writeFileSync(at, `${JSON.stringify(ledger, null, 2)}\n`);
  });

  it("reports progress and a stall in conformance, ordered stalled first", async () => {
    const stalled = await captureReport(
      conformanceWith(await campaignPolicy("2026-10-15T00:00:00Z"), ["src"], {
        format: "json",
        manifestPath: path.join(campaignRoot, "architecture.config.mjs"),
      }),
    );
    const snapshot = JSON.parse(stalled.output) as Snapshot;
    expect(Result.isSuccess(decodeSnapshot(snapshot))).toBe(true);
    expect(
      snapshot.campaigns.map((one) => [one.id, one.count, one.fixed, one.allowed, one.stalled]),
    ).toEqual([
      ["legacy-to-modern", 2, 1, 1, true],
      ["no-throw", 1, 0, 0, true],
    ]);
    // 2 left of 3 ever ledgered.
    expect(snapshot.campaigns[0]?.progress).toBeCloseTo(1 / 3);
    expect(snapshot.campaigns[0]?.owner).toBe("@team/platform");

    const text = await captureReport(
      conformanceWith(await campaignPolicy("2026-10-15T00:00:00Z"), ["src"], {
        format: "text",
        manifestPath: path.join(campaignRoot, "architecture.config.mjs"),
      }),
    );
    expect(text.output).toContain("campaigns: 2 campaigns, 2 stalled");
    expect(text.output).toMatch(
      /legacy-to-modern\s+33%\s+2 left\s+1 fixed\s+1 allowed\s+@team\/platform\s+stalled/,
    );
  });

  it("notices a stall in check without failing, and fails a complete campaign declared remove", async () => {
    const { exit, output } = await captureReport(
      check(await campaignPolicy("2026-10-15T00:00:00Z"), ["src"], "text"),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(output).toContain("notice: campaign legacy-to-modern has stalled");

    rmSync(path.join(campaignRoot, "src/legacy/one.ts"));
    rmSync(path.join(campaignRoot, "src/legacy/three.ts"));
    await captureReport(campaigns(await campaignPolicy(), ["src"], ["prune", "legacy-to-modern"]));
    const done = await checkCampaigns();
    expect(Exit.isFailure(done.exit)).toBe(true);
    expect(done.output).toContain(
      "campaign legacy-to-modern is complete and declares onComplete: remove",
    );
  });

  it("prints the status table, and explains a file's campaigns with a truth table", async () => {
    const status = await captureReport(campaigns(await campaignPolicy(), ["src"], []));
    expect(status.output).toContain("2 campaigns under src");
    expect(status.output).toMatch(/legacy-to-modern\s+100%\s+0 left.*complete/);
    const explained = await captureReport(explain(await campaignPolicy(), "src/thrower.ts"));
    expect(explained.output).toContain("campaigns:");
    expect(explained.output).toContain(
      "campaign/no-throw — Errors are returned, not thrown. (match; 1 hit)",
    );
    expect(explained.output).toMatch(/✓ syntax \{"pattern":"throw new Error\(\$\$\$\)"\} \(1\)/);
  });

  it("routes the campaigns command through run", async () => {
    const { exit, output } = await captureReport(
      run(campaignRoot, ["campaigns", "src"], "architecture.config.mjs"),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(output).toContain("2 campaigns under src");
  });
});

// A `report` term through the live source: one campaign runs a command that
// prints tsc-style lines, another reads an oxlint JSON report a build wrote.
// Each diagnostic is anchored on the declaration at its position.
const reportRoot = path.resolve(here, "../../../.tmp-cli-report-tests");

const REPORT_MANIFEST = `export default {
  resolve: { scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }], unresolved: "off" },
  campaigns: [
    {
      id: "type-errors",
      why: "The strict tsconfig cannot land while these remain.",
      how: "Fix the type error; do not add a cast.",
      scope: ["src/**"],
      unit: "match",
      detect: { report: { command: "node report.mjs", format: "tsc", codesNot: ["TS6133"] } },
      probes: {
        fires: [{ path: "src/a.ts", report: [{ line: 1, code: "TS2551", message: "m" }] }],
        ignores: [{ path: "src/b.ts", report: [{ line: 1, code: "TS6133", message: "unused" }] }],
      },
      staleAfter: "30d",
    },
    {
      id: "lint-debt",
      why: "Every finding the linter carries is a finding nobody reads.",
      how: "Fix the finding, or disable the rule with a reason.",
      scope: ["src/**"],
      unit: "match",
      detect: { report: { file: "oxlint.json", format: "oxlint" } },
      probes: { fires: [{ path: "src/a.ts", report: [{ line: 1, code: "eslint(no-debugger)" }] }] },
      staleAfter: "30d",
    },
  ],
  tree: { "src/": { layout: "open", children: {} } },
};
`;

beforeAll(() => {
  mkdirSync(reportRoot, { recursive: true });
  writeIn(reportRoot, "architecture.config.mjs", REPORT_MANIFEST);
  writeIn(reportRoot, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  writeIn(
    reportRoot,
    "src/a.ts",
    "export function parse(x: string) {\n  return x.nope;\n}\nexport const top = 1;\n",
  );
  writeIn(
    reportRoot,
    "report.mjs",
    [
      "process.stdout.write(\"src/a.ts(2,12): error TS2551: Property 'nope' does not exist on type 'string'.\\n\");",
      "process.stdout.write(\"src/a.ts(2,12): error TS2551: Property 'nope' does not exist on type 'string'.\\n\");",
      "process.stdout.write(\"src/a.ts(4,14): error TS6133: 'top' is declared but never used.\\n\");",
      "process.stdout.write(\"src/a.ts(9,1): error TS1005: ';' expected.\\n\");",
      "process.exitCode = 2;",
      "",
    ].join("\n"),
  );
  writeIn(
    reportRoot,
    "oxlint.json",
    JSON.stringify({
      diagnostics: [
        {
          message: "`debugger` statement is not allowed",
          code: "eslint(no-debugger)",
          severity: "error",
          filename: path.join(reportRoot, "src/a.ts"),
          labels: [{ span: { offset: 0, length: 1, line: 2, column: 3 } }],
        },
      ],
    }),
  );
});

afterAll(() => {
  rmSync(reportRoot, { force: true, recursive: true });
});

describe.sequential("a report term", () => {
  it("runs the command once, reads the file, and anchors each diagnostic on its declaration", async () => {
    const { exit, output } = await captureReport(
      check(await loadPolicy(reportRoot), ["src"], "json"),
    );
    const report = JSON.parse(output) as CheckReport;
    expect(Exit.isFailure(exit)).toBe(true);
    const subjects = report.violations
      .filter((one) => one.kind === "campaign")
      .map((one) => `${one.ruleName}|${one.subject ?? ""}`);
    expect(subjects).toEqual([
      // Two identical diagnostics in `parse` are two entries; TS6133 is
      // excluded by `codesNot`; the one past the end of the file has no anchor.
      expect.stringMatching(/^campaign\/type-errors\|#TS1005#[0-9a-f]{8}$/),
      expect.stringMatching(/^campaign\/type-errors\|parse#TS2551#[0-9a-f]{8}$/),
      expect.stringMatching(/^campaign\/type-errors\|parse#TS2551#[0-9a-f]{8}~2$/),
      expect.stringMatching(/^campaign\/lint-debt\|parse#eslint\(no-debugger\)#[0-9a-f]{8}$/),
    ]);
    expect(report.campaigns.map((one) => [one.id, one.count])).toEqual([
      ["type-errors", 3],
      ["lint-debt", 1],
    ]);
  });

  it("explains the term and its answer", async () => {
    const { output } = await captureReport(explain(await loadPolicy(reportRoot), "src/a.ts"));
    expect(output).toContain("✓ report tsc `node report.mjs` (3)");
    expect(output).toContain("✓ report oxlint file oxlint.json (1)");
  });

  it("is ledgered like any other campaign, and a reworded message is a drifted entry", async () => {
    const policy = await loadPolicy(reportRoot);
    await captureReport(campaigns(policy, ["src"], ["init", "type-errors"]));
    await captureReport(campaigns(policy, ["src"], ["init", "lint-debt"]));
    const ok = await captureReport(check(await loadPolicy(reportRoot), ["src"], "json"));
    expect(Exit.isSuccess(ok.exit), ok.output).toBe(true);

    writeIn(
      reportRoot,
      "report.mjs",
      [
        "process.stdout.write(\"src/a.ts(2,12): error TS2551: Property 'nope' does not exist on type 'string'. Did you mean 'normalize'?\\n\");",
        "process.stdout.write(\"src/a.ts(9,1): error TS1005: ';' expected.\\n\");",
        "",
      ].join("\n"),
    );
    const { exit, output } = await captureReport(
      check(await loadPolicy(reportRoot), ["src"], "json"),
    );
    const report = JSON.parse(output) as CheckReport;
    const typeErrors = report.campaigns.find((one) => one.id === "type-errors");
    // One TS2551 reworded (drifted, still carried), the other gone (stale).
    expect(typeErrors?.drifted).toBe(1);
    expect(typeErrors?.stale).toHaveLength(1);
    expect(typeErrors?.new).toEqual([]);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("fails to load when the report file is missing, naming it", async () => {
    rmSync(path.join(reportRoot, "oxlint.json"));
    const { exit } = await captureReport(check(await loadPolicy(reportRoot), ["src"], "json"));
    expect(Exit.isFailure(exit)).toBe(true);
    const cause = Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "";
    expect(cause).toContain("the report file oxlint.json cannot be read");
  });
});
