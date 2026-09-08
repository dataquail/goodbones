import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { decodeAtlas, decodeSnapshot, type Snapshot } from "@goodbones/core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadPolicyFromFile as loadPolicy } from "./config-loader.js";
import {
  atlasDocument,
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

  it("names the manifest node that governs the file, and says when none does", async () => {
    const governed = (
      await captureReport(explain(await loadPolicy(repoRoot), "src/thing.repository.ts"))
    ).output;
    expect(governed).toContain("governed by: src/*.repository.ts");
    expect(governed).toContain("A port needs its adapter.");

    const ungoverned = (await captureReport(explain(await loadPolicy(repoRoot), "lib/bus.ts")))
      .output;
    expect(ungoverned).toContain("governed by: no node");
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
describe.sequential("atlas", () => {
  it("marks each edge with its status, and lifts the evaluators' answers rather than re-deriving", async () => {
    const policy = await loadPolicy(repoRoot);
    const atlas = atlasDocument(
      policy,
      ["src", "lib"],
      path.join(repoRoot, "architecture.config.mjs"),
    );
    const status = (from: string, to: string) =>
      atlas.edges.find((one) => one.from === from && one.to === to)?.status;

    // src/ reaches lib/, which its allowlist refuses: the import violation is
    // on the edge, and so is the exports one about `makeBus`.
    const refused = atlas.edges.find(
      (one) => one.from === "src/thing.repository.ts" && one.to === "lib/bus.ts",
    );
    expect(refused?.status).toBe("violation");
    expect(refused?.violations).toEqual([
      "import|src/imports|src/thing.repository.ts|lib/bus.ts",
      "export|no-factories|src/thing.repository.ts|lib/bus.ts#makeBus",
    ]);
    // lib/ is under no allowlist, so its edges are ungoverned — and resolved,
    // which `check` never bothers to do.
    expect(status("lib/a.ts", "lib/b.ts")).toBe("ungoverned");
    expect(status("lib/b.ts", "lib/a.ts")).toBe("ungoverned");
    expect(atlas.cycles).toEqual([["lib/a.ts", "lib/b.ts"]]);
    // The files carry their tier; the ghost node with no file is in the nodes.
    expect(atlas.files.find((one) => one.path === "src/thing.repository.ts")?.node).toBe(
      "src/*.repository.ts",
    );
    expect(atlas.files.find((one) => one.path === "lib/bus.ts")?.node).toBeNull();
    expect(atlas.nodes.map((one) => one.path)).toEqual([
      "src/",
      "src/*.repository.ts",
      "src/*.view.tsx",
      "src/ghost/",
    ]);
    expect(atlas.violations.map((one) => one.fingerprint)).toEqual(
      expect.arrayContaining(["graph|no-cycles|lib/a.ts|lib/a.ts ↔ lib/b.ts"]),
    );
  });

  it("emits one JSON document that decodes against the published shape", async () => {
    const { exit, output } = await captureReport(run(repoRoot, ["atlas", "src", "lib"]));
    expect(Exit.isSuccess(exit)).toBe(true);
    const decoded = decodeAtlas(JSON.parse(output) as unknown);
    expect(Result.isSuccess(decoded), JSON.stringify(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.version).toBe(1);
      expect(decoded.success.manifest.path).toBe("architecture.config.mjs");
      expect(decoded.success.roots).toEqual(["src", "lib"]);
    }
  });
});

// This repository is the acceptance test: its policy has no violation and no
// ungoverned source file, so every observed edge is admitted, and the
// allowances nothing uses are exactly the snapshot's slack.
describe("atlas, over this repository", () => {
  const thisRepository = path.resolve(here, "../../..");
  // The four `src/` trees, named, as the infer test does: the other test files
  // write fixtures under `packages/cli/` while this runs.
  const SOURCES = [
    "packages/core/src",
    "packages/typescript/src",
    "packages/cli/src",
    "packages/oxlint/src",
  ];

  it("admits every edge, and its unused designed edges are the snapshot's slack", async () => {
    const policy = await loadPolicy(thisRepository);
    const manifestPath = path.join(thisRepository, "architecture.yaml");
    const atlas = atlasDocument(policy, SOURCES, manifestPath);
    const snapshot = snapshotOf(policy, SOURCES, manifestPath);

    expect(atlas.edges.length).toBeGreaterThan(100);
    expect([...new Set(atlas.edges.map((one) => one.status))]).toEqual(["admitted"]);
    expect(atlas.edges.every((one) => one.admittedBy !== undefined)).toBe(true);
    expect(atlas.files.filter((one) => !one.external).every((one) => one.node !== null)).toBe(true);
    // A node from an included file names the file.
    expect(atlas.nodes.find((one) => one.path === "~/core/src/domain/")?.file).toBe(
      "packages/core/architecture.yaml",
    );
    // The snapshot attributes an entry that came through `use` to the
    // fragment, once; the atlas keeps it at each node it is in force at.
    const unused = new Set(
      atlas.designed
        .filter((one) => !one.used)
        .map(
          (one) =>
            `${one.allowance.fragment ?? one.node} ${one.allowance.kind} ${one.allowance.entry}`,
        ),
    );
    expect([...unused].sort()).toEqual(
      [...new Set(snapshot.slack.map((one) => `${one.node} ${one.kind} ${one.entry}`))].sort(),
    );
    expect(Result.isSuccess(decodeAtlas(JSON.parse(JSON.stringify(atlas)) as unknown))).toBe(true);
  }, 60_000);
});

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
