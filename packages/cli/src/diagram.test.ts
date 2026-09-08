import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { renderMermaid } from "@goodbones/core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadPolicyFromFile as loadPolicy } from "./config-loader.js";
import { diagramView, parseDiagramFlags } from "./diagram.js";
import { atlasDocument, run } from "./run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../.tmp-cli-diagram");
// This repository: the golden below is its package graph.
const thisRepository = path.resolve(here, "../../..");

// Three tiers and one planted violation: domain/ reaches infra/.
const MANIFEST = `export default {
  resolve: { scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }], unresolved: "off" },
  tree: {
    "src/": {
      message: "src/ is the program.",
      layout: "open",
      imports: { message: "src/ reaches itself.", allow: ["src/**"] },
      children: {
        "domain/": {
          message: "domain/ is the model.",
          layout: "open",
          imports: { message: "domain/ reaches only itself.", reset: true, allow: ["src/domain/**"] },
          children: {},
        },
        "**/": { layout: "open", children: {} },
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
  write("src/app/server.ts", 'import "../domain/user.ts";\nimport "../infra/db.ts";\n');
  write("src/domain/user.ts", 'import "./order.ts";\n');
  write("src/domain/order.ts", 'import "../infra/db.ts";\n');
  write("src/infra/db.ts", "export const db = 1;\n");
});

afterAll(() => {
  rmSync(repoRoot, { force: true, recursive: true });
});

const manifestPath = () => path.join(repoRoot, "architecture.config.mjs");

const captureStdout = async (effect: Effect.Effect<void, unknown>) => {
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

describe("parseDiagramFlags", () => {
  it("reads every flag, and a bare argument as a walk root", () => {
    expect(
      parseDiagramFlags([
        "--root",
        "src/",
        "--depth",
        "2",
        "--focus",
        "./src/a.ts",
        "--focus",
        "src/b.ts",
        "--designed",
        "--outside",
        "lib",
      ]),
    ).toEqual(
      Result.succeed({
        root: "src",
        focus: ["src/a.ts", "src/b.ts"],
        depth: 2,
        designed: true,
        outside: true,
        roots: ["lib"],
      }),
    );
  });

  it("defaults to depth 1, no ghosts, no outside, and the packages root", () => {
    expect(parseDiagramFlags([])).toEqual(
      Result.succeed({
        root: null,
        focus: [],
        depth: 1,
        designed: false,
        outside: false,
        roots: ["packages"],
      }),
    );
  });

  it("refuses a depth it cannot draw, a flag without a value, and a flag it does not know", () => {
    expect(Result.isFailure(parseDiagramFlags(["--depth", "3"]))).toBe(true);
    expect(Result.isFailure(parseDiagramFlags(["--root"]))).toBe(true);
    expect(Result.isFailure(parseDiagramFlags(["--colour"]))).toBe(true);
  });
});

describe.sequential("diagram", () => {
  it("draws the one walk root by default, and the planted violation as a thick red edge", async () => {
    const { exit, output } = await captureStdout(run(repoRoot, ["diagram", "src"]));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(output).toBe(
      `flowchart TB
  n_src_app["app/"]
  n_src_domain["domain/ ⚠ 1"]
  n_src_infra["infra/"]
  n_src_app --> n_src_domain
  n_src_app --> n_src_infra
  n_src_domain ==> n_src_infra
  linkStyle 2 stroke:#c62828,stroke-width:2px
`,
    );
  });

  it("centres on the folder the --focus files share, and nests at --depth 2", async () => {
    const { output } = await captureStdout(
      run(repoRoot, ["diagram", "--focus", "src/domain/user.ts", "--depth", "2", "src"]),
    );
    expect(output).toContain('  n_src_domain_order_ts["order.ts ⚠ 1"]');
    expect(output).toContain("  n_src_domain_user_ts --> n_src_domain_order_ts");
    // Edges leaving the folder are hidden unless asked for.
    expect(output).not.toContain("infra");
    const shown = await captureStdout(
      run(repoRoot, ["diagram", "--root", "src/domain", "--outside", "src"]),
    );
    expect(shown.output).toContain('  n_src_infra["../infra/"]');
    expect(shown.output).toContain("  n_src_domain_order_ts ==> n_src_infra");
    expect(shown.output).toContain("  class n_src_infra outside");
  });

  it("refuses a folder holding no walked file, naming where to look", async () => {
    const { exit } = await captureStdout(run(repoRoot, ["diagram", "--root", "elsewhere", "src"]));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("renders what the view holds, so the two never disagree", async () => {
    const policy = await loadPolicy(repoRoot);
    const flags = parseDiagramFlags(["src"]);
    if (Result.isFailure(flags)) throw new Error(flags.failure);
    const view = diagramView(atlasDocument(policy, ["src"], manifestPath()), flags.success);
    const { output } = await captureStdout(run(repoRoot, ["diagram", "src"]));
    expect(output).toBe(renderMermaid(view));
  });
});

// The package graph of this repository, as a golden: four packages, the two
// hosts on the core and the pack, the pack on the core, nothing else.
describe("diagram, over this repository", () => {
  // The four `src/` trees, named, as the other self-hosting tests do: the
  // fixtures other test files write under `packages/cli/` are not the graph.
  const SOURCES = [
    "packages/core/src",
    "packages/typescript/src",
    "packages/cli/src",
    "packages/oxlint/src",
  ];

  it("draws the four packages and the edges between them", async () => {
    const policy = await loadPolicy(thisRepository);
    const flags = parseDiagramFlags(["--root", "packages", ...SOURCES]);
    if (Result.isFailure(flags)) throw new Error(flags.failure);
    const atlas = atlasDocument(policy, SOURCES, path.join(thisRepository, "architecture.yaml"));
    expect(renderMermaid(diagramView(atlas, flags.success))).toBe(
      `flowchart TB
  n_packages_cli["cli/"]
  n_packages_core["core/"]
  n_packages_oxlint["oxlint/"]
  n_packages_typescript["typescript/"]
  n_packages_cli -- ${String(count(atlas, "packages/cli", "packages/core"))} --> n_packages_core
  n_packages_cli -- ${String(count(atlas, "packages/cli", "packages/typescript"))} --> n_packages_typescript
  n_packages_oxlint -- ${String(count(atlas, "packages/oxlint", "packages/core"))} --> n_packages_core
  n_packages_oxlint -- ${String(count(atlas, "packages/oxlint", "packages/typescript"))} --> n_packages_typescript
  n_packages_typescript -- ${String(count(atlas, "packages/typescript", "packages/core"))} --> n_packages_core
`,
    );
  }, 60_000);
});

// How many atlas edges run from one folder into another: the counts on the
// golden's edges move with every import added, and are not the architecture.
const count = (atlas: ReturnType<typeof atlasDocument>, from: string, to: string): number =>
  atlas.edges.filter((one) => one.from.startsWith(`${from}/`) && one.to.startsWith(`${to}/`))
    .length;
