import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cli } from "../cli.js";
import { type FileContent, type ImportSpec, source, typescript } from "../profile.js";
import { createRepo, type Repo } from "../repo.js";

// How long `check` and `conformance` take over a large generated repository.
// Not a gate, and not part of the suite: it runs only under `BENCH=1`, prints a
// table and asserts nothing about time. It is how a change to the parse, the
// walk or the resolver is proven rather than assumed — run it on `main` and on
// the branch, and put both tables in the PR.
//
//   BENCH=1 pnpm exec vitest run src/bench --root e2e
//   BENCH=1 BENCH_FILES=2000 BENCH_RUNS=5 pnpm exec vitest run src/bench --root e2e
//   BENCH=1 BENCH_BIN=/elsewhere/packages/cli/build/esm/main.js …   # another checkout's build
//   BENCH=1 BENCH_BODY=0 …                                          # the facts alone, no body
//
// The tree is four layers of `BENCH_FILES` files, each importing a handful of
// files from its own layer and the ones beneath it, exporting a few names,
// declaring a type with members and making a call — every family has
// something to read in every file — and then `BENCH_BODY` blocks of ordinary
// code the policy says nothing about, because a real file is mostly that and
// the parser reads all of it. The default is about ninety lines a file. The
// manifest carries every family too, so the numbers are what a policy of this
// shape costs, not what an empty one does.

const FILES = Number(process.env.BENCH_FILES ?? 10_000);
const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const BODY = Number(process.env.BENCH_BODY ?? 12);
const BIN = process.env.BENCH_BIN;

const LAYERS = ["domain", "application", "infrastructure", "ui"] as const;
const FAN_OUT = 4;
const PER_FOLDER = 25;

// A fixed-seed generator, so two runs see the same tree.
const lcg = (seed: number) => {
  let state = seed >>> 0;
  return (bound: number): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % bound;
  };
};

type Generated = {
  readonly files: Readonly<Record<string, FileContent>>;
  readonly manifest: Readonly<Record<string, unknown>>;
};

const generate = (count: number): Generated => {
  const next = lcg(1);
  const names: Array<string> = [];
  const perLayer = Math.ceil(count / LAYERS.length);
  for (const layer of LAYERS) {
    for (let i = 0; i < perLayer && names.length < count; i++) {
      names.push(`src/${layer}/folder${String(Math.floor(i / PER_FOLDER))}/module${String(i)}.ts`);
    }
  }
  const layerOf = (file: string): number =>
    LAYERS.findIndex((layer) => file.includes(`/${layer}/`));
  const byLayer = LAYERS.map((_, index) => names.filter((file) => layerOf(file) === index));

  const files: Record<string, FileContent> = {};
  names.forEach((file, index) => {
    const layer = layerOf(file);
    // A file reaches its own layer and the ones beneath it, never above — the
    // layering the manifest states, so the run reports few violations and
    // resolves every edge.
    const reachable = byLayer.slice(0, layer + 1).flat();
    const imports: Array<ImportSpec> = [];
    for (let k = 0; k < FAN_OUT; k++) {
      const target = reachable[next(reachable.length)];
      if (target === undefined || target === file) continue;
      const relative = specifierOf(file, target);
      imports.push(
        k % 2 === 0
          ? { from: relative, names: [`value${String(index % 3)}`] }
          : { from: relative, namespace: `ns${String(k)}` },
      );
    }
    const facts = source({
      imports,
      exports: ["value0", "value1", "value2"],
      declares: [
        {
          type: `Port${String(index)}Shape`,
          members: ["findOne", "save", `custom${String(index % 7)}`],
        },
        { calls: index % 5 === 0 ? "useState" : "run" },
      ],
    });
    files[file] = typescript.render(facts) + bodyOf(index);
  });
  // The entry the orphan rule starts from: it imports the first file of every
  // layer, and everything else is reached through fan-out or is an orphan.
  files["src/main.ts"] = source({
    imports: byLayer.map((layer, index) => ({
      from: specifierOf("src/main.ts", layer[0] ?? ""),
      namespace: `layer${String(index)}`,
    })),
  });

  const manifest = {
    resolve: {
      scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }],
    },
    graph: {
      cycles: [{ name: "no-cycles", message: "These files import each other.", within: "src/**" }],
      orphans: [
        {
          name: "no-orphans",
          message: "Nothing imports this file.",
          within: "src/**",
          entry: ["src/main.ts"],
        },
      ],
      reach: [
        {
          name: "domain-reaches-no-ui",
          message: "The domain reaches no view.",
          from: "src/domain/**",
          to: "src/ui/**",
        },
      ],
    },
    exports: [
      {
        name: "no-value2-from-infrastructure",
        message: "value2 is constructed at the root.",
        module: "src/infrastructure/**",
        symbols: ["value2"],
        except: ["src/main.ts", "src/ui/**"],
      },
    ],
    tree: {
      "src/": {
        message: "src/ is four layers and an entry.",
        imports: { message: "src/ reaches only itself.", allow: ["src/**"] },
        children: {
          "main.ts": {},
          "domain/": {
            layout: "open",
            imports: { message: "The domain reaches only itself.", allow: ["src/domain/**"] },
            children: {},
            members: [
              {
                message: 'Port method "{name}" is not in the vocabulary.',
                subject: "members",
                declares: ["type"],
                in: "*Shape",
                allow: ["findOne", "save", "custom*"],
              },
            ],
          },
          "application/": {
            layout: "open",
            imports: {
              message: "The application reaches the domain.",
              allow: ["src/application/**", "src/domain/**"],
            },
            children: {},
          },
          "infrastructure/": {
            layout: "open",
            imports: {
              message: "Infrastructure reaches the application and the domain.",
              allow: ["src/infrastructure/**", "src/application/**", "src/domain/**"],
            },
            children: {},
          },
          "ui/": {
            layout: "open",
            imports: { message: "The UI reaches everything beneath it.", allow: ["src/**"] },
            children: {},
            surface: [{ message: "A view exports no default.", kinds: ["default"] }],
            members: [
              {
                message: "`{name}` puts state in the view.",
                subject: "calls",
                match: "use[A-Z]*",
                allow: ["useAtomValue"],
              },
            ],
          },
        },
      },
    },
  };

  return { files, manifest };
};

// Ordinary code: a function with a body, a class, an interface — the shapes a
// file is mostly made of, none of which the manifest above speaks about.
const bodyOf = (index: number): string => {
  const blocks: Array<string> = [];
  for (let k = 0; k < BODY; k += 1) {
    const id = `${String(index)}_${String(k)}`;
    blocks.push(
      `export const fn${id} = (a: number, b: string): string => {`,
      `  const joined = [a, b].map(String).join(",");`,
      `  if (joined.length > ${String(k)}) return joined;`,
      "  return `${joined}!`;",
      `};`,
      `export class Service${id} { private n = ${String(k)}; run(): number { return this.n + 1; } }`,
      `export interface Shape${id} { a: string; b(): void }`,
    );
  }
  return blocks.length === 0 ? "" : `${blocks.join("\n")}\n`;
};

const specifierOf = (from: string, to: string): string => {
  const fromParts = from.split("/").slice(0, -1);
  const toParts = to.split("/");
  let shared = 0;
  while (shared < fromParts.length && fromParts[shared] === toParts[shared]) shared += 1;
  const up = fromParts.length - shared;
  const rest = toParts.slice(shared).join("/");
  return up === 0 ? `./${rest}` : `${"../".repeat(up)}${rest}`;
};

type Timing = {
  readonly command: string;
  readonly runs: ReadonlyArray<number>;
  readonly files: number;
  readonly violations: number;
};

const time = (repo: Repo, argv: ReadonlyArray<string>): Timing => {
  const runs: Array<number> = [];
  let files = 0;
  let violations = 0;
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    const result = cli(repo, [...argv, "--json", "src"], {
      maxBuffer: 1 << 30,
      ...(BIN === undefined ? {} : { bin: BIN }),
    });
    runs.push(performance.now() - started);
    if (result.stdout.length === 0) {
      throw new Error(`${argv.join(" ")} printed nothing:\n${result.stderr}`);
    }
    const json = JSON.parse(result.stdout) as {
      readonly files?: number;
      readonly violations?: ReadonlyArray<unknown>;
    };
    files = json.files ?? 0;
    violations = json.violations?.length ?? 0;
  }
  return { command: argv.join(" "), runs, files, violations };
};

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const format = (timings: ReadonlyArray<Timing>): string => {
  const rows = timings.map((one) => [
    one.command,
    String(one.files),
    String(one.violations),
    `${median(one.runs).toFixed(0)} ms`,
    `${Math.min(...one.runs).toFixed(0)} ms`,
    `${(median(one.runs) / one.files).toFixed(2)} ms/file`,
  ]);
  const header = ["command", "files", "violations", "median", "best", "per file"];
  const widths = header.map((_, i) =>
    Math.max(header[i]?.length ?? 0, ...rows.map((r) => r[i]?.length ?? 0)),
  );
  const line = (cells: ReadonlyArray<string>) =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(" | ")} |`;
  return [
    line(header),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...rows.map(line),
  ].join("\n");
};

describe.skipIf(process.env.BENCH === undefined)("scale", () => {
  let repo: Repo;
  let generated: Generated;

  beforeAll(() => {
    generated = generate(FILES);
    repo = createRepo({ files: generated.files, manifest: generated.manifest });
  });
  afterAll(() => {
    repo.dispose();
  });

  it(`times check and conformance over ${String(FILES)} files`, () => {
    const withoutGraph = { ...generated.manifest };
    delete (withoutGraph as { graph?: unknown }).graph;

    repo.writeManifest(withoutGraph);
    const perFile = time(repo, ["check"]);
    repo.writeManifest(generated.manifest);
    const withGraph = time(repo, ["check"]);
    const conformance = time(repo, ["conformance"]);

    const table = format([
      { ...perFile, command: "check (per-file families)" },
      { ...withGraph, command: "check (with graph)" },
      { ...conformance, command: "conformance" },
    ]);
    process.stdout.write(
      `\n${String(FILES)} files, ${String(RUNS)} runs each, median and best:\n${table}\n\n`,
    );

    // Only that the runs saw the tree; time is reported, not judged.
    expect(perFile.files).toBe(FILES + 1);
  });
});
