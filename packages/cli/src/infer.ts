import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";

import {
  type Candidate,
  candidatesOf,
  coverageOf,
  cyclesIn,
  formatManifestYaml,
  fractionsOf,
  type Generalization,
  inferManifest,
  type InferredTarget,
  listPackageRoots,
  listSourceFiles,
  type LoadedPolicy,
  type Manifest,
  MANIFEST_FILENAMES,
  MANIFEST_SCHEMA_ID,
  type SourceFacts,
} from "@goodbones/core";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { hostLanguages, loadPolicyFromFile, loadPolicyFromManifest } from "./config-loader.js";
import { buildGraph } from "./graph.js";
import { sourceFactsOf } from "./source-facts.js";

// `architecture infer`: the as-built manifest, for a repository that has none.
//
// The core decides what the tree says (`inferManifest`); this command is the
// host around it — it walks, parses and resolves every file, asks the human
// the questions only a human can answer, proves the result loads, and writes
// the YAML. Nothing in the core knows a terminal exists.

export type CliFailure = { readonly _tag: "CliFailure"; readonly message: string };
const fail = (message: string): CliFailure => ({ _tag: "CliFailure", message });

export type InferFlags = {
  readonly depth: number;
  readonly roots: ReadonlyArray<string>;
  readonly tsconfig: string | null;
  readonly write: boolean;
  // How the questions are answered: at the terminal, all yes, or not asked.
  readonly answers: "ask" | "yes" | "exhaustive";
  readonly collapse: boolean;
};

export const INFER_USAGE =
  "infer [--depth N] [--root DIR]... [--tsconfig PATH] [--write] [--yes | --exhaustive] [--collapse]";

export const parseInferFlags = (argv: ReadonlyArray<string>): Result.Result<InferFlags, string> => {
  let depth = 2;
  const roots: Array<string> = [];
  let tsconfig: string | null = null;
  let write = false;
  let answers: InferFlags["answers"] = "ask";
  let collapse = false;

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === undefined) break;
    const value = (): Result.Result<string, string> => {
      const next = args.shift();
      return next === undefined || next.startsWith("--")
        ? Result.fail(`${arg} needs a value`)
        : Result.succeed(next);
    };
    switch (arg) {
      case "--depth": {
        const given = value();
        if (Result.isFailure(given)) return Result.fail(given.failure);
        const parsed = Number(given.success);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return Result.fail(`--depth takes a whole number, not "${given.success}"`);
        }
        depth = parsed;
        break;
      }
      case "--root": {
        const given = value();
        if (Result.isFailure(given)) return Result.fail(given.failure);
        roots.push(given.success);
        break;
      }
      case "--tsconfig": {
        const given = value();
        if (Result.isFailure(given)) return Result.fail(given.failure);
        tsconfig = given.success;
        break;
      }
      case "--write":
        write = true;
        break;
      case "--yes":
        answers = "yes";
        break;
      case "--exhaustive":
        answers = "exhaustive";
        break;
      case "--collapse":
        collapse = true;
        break;
      default:
        if (arg.startsWith("--")) return Result.fail(`unknown flag ${arg}. Usage: ${INFER_USAGE}`);
        roots.push(arg);
    }
  }
  return Result.succeed({ depth, roots, tsconfig, write, answers, collapse });
};

// What the command talks through, so a test can answer the questions and
// read the output without a terminal.
export type InferIo = {
  readonly out: (text: string) => void;
  readonly err: (line: string) => void;
  readonly ask: (question: string) => Promise<boolean>;
  readonly interactive: boolean;
};

export const terminalIo = (): InferIo => ({
  out: (text) => process.stdout.write(text),
  err: (line) => process.stderr.write(`${line}\n`),
  ask: async (question) => {
    // The questions go to stderr so stdout stays the manifest.
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
      return answer === "" || answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  },
  interactive: process.stdin.isTTY === true,
});

const normalizeRoot = (root: string): string =>
  root.replaceAll(path.sep, "/").replace(/^\.\//, "").replace(/\/+$/, "");

const isGlob = (key: string): boolean => /[*{}|[\]]/.test(key);

// The top-level keys of an existing manifest, as folders: aliases expanded,
// the trailing slash dropped, and any key that is a pattern left out.
const rootsOfManifest = (manifest: Manifest): ReadonlyArray<string> => {
  const aliases = Object.entries(manifest.aliases ?? {}).sort(([a], [b]) => b.length - a.length);
  const expand = (key: string): string => {
    for (const [alias, target] of aliases) {
      if (key === alias) return target;
      if (key.startsWith(`${alias}/`)) return `${target}${key.slice(alias.length)}`;
    }
    return key;
  };
  return Object.keys(manifest.tree)
    .filter((key) => !isGlob(key))
    .map((key) => normalizeRoot(expand(key)))
    .filter((key) => key !== "");
};

// With no manifest to read them from: `src/` when there is one, otherwise
// every top-level folder that holds a source file.
const rootsOfRepository = (
  repoRoot: string,
  languages: LoadedPolicy["languages"],
): ReadonlyArray<string> => {
  if (existsSync(path.join(repoRoot, "src"))) return ["src"];
  const folders = readdirSync(repoRoot).filter((entry) => {
    if (entry.startsWith(".")) return false;
    try {
      return statSync(path.join(repoRoot, entry)).isDirectory();
    } catch {
      return false;
    }
  });
  return folders.filter((folder) => listSourceFiles(repoRoot, [folder], languages).length > 0);
};

// A policy that can resolve the tree and nothing else: one open root per
// walk root, no allowlist, resolution through the tsconfig the flag names or
// the one at the repository root.
const bootstrapManifest = (roots: ReadonlyArray<string>, tsconfig: string): Manifest => ({
  resolve: {
    scopes: [{ files: "", language: "typescript", options: { tsconfig } }],
    unresolved: "off",
  },
  tree: Object.fromEntries(
    roots.map((root) => [
      `${root}/`,
      { layout: "open" as const, imports: { unrestricted: true }, children: {} },
    ]),
  ),
});

type Setting = {
  readonly policy: LoadedPolicy;
  readonly roots: ReadonlyArray<string>;
  readonly resolve: Manifest["resolve"];
  readonly aliases: Readonly<Record<string, string>> | undefined;
  readonly baseline: string;
};

const settingOf = async (
  repoRoot: string,
  configFilename: string | undefined,
  flags: InferFlags,
): Promise<Result.Result<Setting, string>> => {
  const hasManifest =
    configFilename !== undefined ||
    MANIFEST_FILENAMES.some((name) => existsSync(path.resolve(repoRoot, name)));

  if (hasManifest && flags.tsconfig === null) {
    const policy = await loadPolicyFromFile(repoRoot, configFilename);
    const fromManifest = rootsOfManifest(policy.config);
    const roots =
      flags.roots.length > 0
        ? flags.roots.map(normalizeRoot)
        : fromManifest.length > 0
          ? fromManifest
          : rootsOfRepository(repoRoot, policy.languages);
    return Result.succeed({
      policy,
      roots,
      resolve: policy.config.resolve,
      aliases: policy.config.aliases,
      baseline: policy.config.baseline ?? ".architecture-baseline.json",
    });
  }

  const tsconfig = flags.tsconfig ?? "tsconfig.json";
  if (!existsSync(path.resolve(repoRoot, tsconfig))) {
    return Result.fail(
      `${tsconfig} does not exist, and the TypeScript resolver needs one to turn a specifier ` +
        `into a file. Name the right one with --tsconfig <path>.`,
    );
  }
  const roots =
    flags.roots.length > 0
      ? flags.roots.map(normalizeRoot)
      : rootsOfRepository(repoRoot, hostLanguages());
  if (roots.length === 0) {
    return Result.fail(
      "no source files found under any top-level folder. Name the folder to describe with --root <dir>.",
    );
  }
  const loaded = loadPolicyFromManifest(repoRoot, bootstrapManifest(roots, tsconfig));
  if (Result.isFailure(loaded)) return Result.fail(String(loaded.failure));
  return Result.succeed({
    policy: loaded.success,
    roots,
    resolve: { ...loaded.success.config.resolve, unresolved: "error" },
    aliases: undefined,
    baseline: ".architecture-baseline.json",
  });
};

const describeCandidate = (candidate: Candidate): string => {
  const parent = candidate.parent === "" ? "the root" : `${candidate.parent}/`;
  const shared = [
    ...candidate.sharedFolders.map((one) => `${one}/`),
    ...candidate.sharedStereotypes,
  ];
  const key =
    candidate.parent === ""
      ? `{${candidate.capture}}/`
      : `${candidate.parent}/{${candidate.capture}}/`;
  return (
    `\n${parent}: ${candidate.members.join(", ")} each have ${shared.join(", ")}.\n` +
    `  Describe them as one node, ${key}?`
  );
};

const describeReach = (candidate: Candidate): string => {
  const glob =
    candidate.parent === ""
      ? `*/${candidate.crossReach ?? ""}`
      : `${candidate.parent}/*/${candidate.crossReach ?? ""}`;
  return (
    `  All ${String(candidate.crossEdges)} imports between them land on ${candidate.crossReach ?? ""}.\n` +
    `  Restrict what one may reach in another to ${glob}?`
  );
};

const keyOf = (candidate: Candidate): string =>
  `${candidate.parent}:${candidate.members.join(",")}`;

// The questionnaire. Each round recomputes the candidates over the tree as
// it now stands, so a group accepted at one level can reveal one above it;
// a declined group is not asked twice.
const decide = async (
  input: Parameters<typeof candidatesOf>[0],
  flags: InferFlags,
  io: InferIo,
): Promise<ReadonlyArray<Generalization>> => {
  if (flags.answers === "exhaustive") return [];
  const accepted: Array<Generalization> = [];
  const declined = new Set<string>();
  for (;;) {
    const next = candidatesOf(input, accepted).find((one) => !declined.has(keyOf(one)));
    if (next === undefined) break;
    const yes = flags.answers === "yes" || (await io.ask(describeCandidate(next)));
    if (!yes) {
      declined.add(keyOf(next));
      continue;
    }
    const tighten =
      next.crossReach !== null && (flags.answers === "yes" || (await io.ask(describeReach(next))));
    accepted.push({
      parent: next.parent,
      members: next.members,
      capture: next.capture,
      crossReach: tighten ? next.crossReach : null,
    });
  }
  return accepted;
};

const today = (): string => new Date().toISOString().slice(0, 10);

const header = (date: string): string =>
  `# yaml-language-server: $schema=${MANIFEST_SCHEMA_ID}
#
# The as-built architecture of this repository, inferred on ${date} by
# \`architecture infer\`. Every node says what its folder does today — what it
# imports, and nothing about what it may not. Each \`allow\` entry is a fact;
# each one you delete is a decision. \`unrestricted: true\` marks a node nobody
# has reviewed yet, and \`limits.unrestricted\` counts how many remain: lower it
# as you go, and the policy refuses to drift back.
#
# https://dataquail.github.io/goodbones/architecture-rules/getting-started/infer/

`;

export type InferOutcome = {
  readonly manifest: Manifest;
  readonly yaml: string;
  readonly files: number;
  readonly nodes: number;
  readonly unresolved: ReadonlyArray<string>;
  readonly generalized: ReadonlyArray<Generalization>;
};

export const infer = (
  repoRoot: string,
  argv: ReadonlyArray<string>,
  configFilename: string | undefined,
  io: InferIo = terminalIo(),
): Effect.Effect<InferOutcome, CliFailure> =>
  Effect.gen(function* () {
    const parsed = parseInferFlags(argv);
    if (Result.isFailure(parsed)) return yield* Effect.fail(fail(parsed.failure));
    const flags = parsed.success;

    if (flags.write) {
      const present = MANIFEST_FILENAMES.filter((name) => existsSync(path.resolve(repoRoot, name)));
      if (present.length > 0) {
        return yield* Effect.fail(
          fail(
            `${present.join(", ")} already exists. \`infer --write\` writes a manifest for a ` +
              `repository that has none, and does not overwrite one; leave --write off to print it.`,
          ),
        );
      }
    }

    const setting = yield* Effect.tryPromise({
      try: () => settingOf(repoRoot, configFilename, flags),
      catch: (cause) => fail(String(cause)),
    });
    if (Result.isFailure(setting)) return yield* Effect.fail(fail(setting.failure));
    const { aliases, baseline, policy, resolve, roots } = setting.success;

    for (const root of roots) {
      const absolute = path.resolve(repoRoot, root);
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
        return yield* Effect.fail(fail(`--root ${root} is not a folder under ${repoRoot}`));
      }
    }

    const files = listSourceFiles(repoRoot, roots, policy.languages);
    const packages = listPackageRoots(repoRoot, roots, policy.languages);

    const parsedFacts = new Map<string, SourceFacts>();
    const factsOf = (file: string): SourceFacts => {
      const cached = parsedFacts.get(file);
      if (cached !== undefined) return cached;
      const facts = sourceFactsOf(repoRoot, file, policy.extractor);
      parsedFacts.set(file, facts);
      return facts;
    };

    const targets = new Map<string, ReadonlyArray<InferredTarget>>();
    const unresolved: Array<string> = [];
    for (const file of files) {
      const found: Array<InferredTarget> = [];
      for (const specifier of factsOf(file).specifiers) {
        const resolved = policy.resolver.resolve(file, specifier);
        if (Result.isFailure(resolved)) {
          if (!policy.ignoreUnresolved.some((pattern) => pattern.test(specifier))) {
            unresolved.push(`${file} → ${specifier} (${resolved.failure.detail})`);
          }
          continue;
        }
        const target = resolved.success;
        found.push(
          target.kind === "local"
            ? { kind: "local", path: target.path }
            : target.kind === "builtin"
              ? { kind: "builtin", path: target.path }
              : { kind: "external", package: target.package ?? target.path },
        );
      }
      targets.set(file, found);
    }

    const input = {
      files,
      targetsOf: (file: string) => targets.get(file) ?? [],
      roots,
      packages,
      depth: flags.depth,
    };

    if (flags.answers === "ask" && !io.interactive) {
      io.err(
        "not a terminal, so no questions: every folder gets a node of its own. " +
          "Pass --yes to accept every generalization, or run this at a terminal.",
      );
    }
    const generalized = yield* Effect.promise(() =>
      decide(
        input,
        flags.answers === "ask" && !io.interactive ? { ...flags, answers: "exhaustive" } : flags,
        io,
      ),
    );

    const date = today();
    const hasCycles = cyclesIn(buildGraph(files, policy.resolver, factsOf)).length > 0;
    const inferred = inferManifest(input, {
      generalize: generalized,
      collapse: flags.collapse,
      date,
      resolve,
      aliases,
      baseline,
      hasCycles,
    });

    // The proof: what was written loads, every probe passes, and the floors
    // are the numbers it reaches today.
    const loaded = loadPolicyFromManifest(repoRoot, inferred.manifest);
    if (Result.isFailure(loaded)) {
      return yield* Effect.fail(
        fail(
          `infer wrote a manifest that does not load — this is a bug: ${String(loaded.failure)}`,
        ),
      );
    }
    const fractions = fractionsOf(coverageOf(loaded.success, files));
    const floor = (fraction: number): number => Math.floor(fraction * 100) / 100;
    const coverage: Partial<Record<keyof typeof fractions, number>> = {};
    for (const family of ["imports", "structure", "members", "surface", "graph"] as const) {
      if (fractions[family] > 0) coverage[family] = floor(fractions[family]);
    }
    const manifest: Manifest = {
      ...inferred.manifest,
      limits: { ...inferred.manifest.limits, coverage },
    };
    const yaml = `${header(date)}${formatManifestYaml(manifest)}`;

    if (flags.write) {
      yield* Effect.sync(() => {
        writeFileSync(path.resolve(repoRoot, "architecture.yaml"), yaml);
      });
    } else {
      yield* Effect.sync(() => {
        io.out(yaml);
      });
    }

    yield* Effect.sync(() => {
      const summary =
        `${String(files.length)} files under ${roots.join(", ")}: ${String(inferred.nodes)} nodes` +
        (generalized.length > 0 ? `, ${String(generalized.length)} generalized` : "") +
        (hasCycles ? "; the graph has a cycle, so no no-cycles rule was written" : "");
      io.err(flags.write ? `wrote architecture.yaml. ${summary}.` : summary);
      if (unresolved.length > 0) {
        io.err("");
        io.err(
          `${String(unresolved.length)} imports could not be resolved, and are in no allowlist. ` +
            "`check` will report them until the resolver can see them or `ignoreUnresolved` names them:",
        );
        for (const one of unresolved) io.err(`  ${one}`);
      }
      if (flags.write) {
        io.err("");
        io.err("  architecture check       # should be clean: the manifest describes today");
        io.err("  architecture coverage    # every node is unrestricted; review them one by one");
      }
    });

    return {
      manifest,
      yaml,
      files: files.length,
      nodes: inferred.nodes,
      unresolved,
      generalized,
    };
  });
