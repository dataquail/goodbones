import * as fc from "fast-check";

import { type FileSpec, type ImportSpec, type Profile, source } from "../profile.js";
import { createRepo, type Repo } from "../repo.js";

// Generated repositories: a tree of folders from a small alphabet, five to
// forty files, each importing a few of the others and up to two stubbed
// externals. Rendered through the profile, so nothing here spells a language.
//
// The second tier's properties are metamorphic — how a report changes when the
// tree changes — never a model of the evaluators: a model of the evaluators is
// the evaluators again, in a test.

const FOLDERS = ["auth", "billing", "orders", "shared", "platform", "domain", "commands"];
const NAMES = ["index", "service", "handler", "model", "util", "client", "types", "main"];

// Each external the profile stubs, with the subpaths it exposes, and the
// specifiers a file may import from it.
export const EXTERNALS: Readonly<Record<string, ReadonlyArray<string>>> = {
  effect: ["Effect", "Schema"],
  zod: [],
  react: [],
};
const EXTERNAL_SPECIFIERS = Object.entries(EXTERNALS).flatMap(([name, subpaths]) => [
  name,
  ...subpaths.map((subpath) => `${name}/${subpath}`),
]);

export type Tree = {
  // Repo-relative paths, all under `src/`, distinct.
  readonly files: ReadonlyArray<string>;
  // Per file, the files it imports (indices into `files`) and the externals.
  readonly edges: ReadonlyArray<{
    readonly local: ReadonlyArray<number>;
    readonly external: ReadonlyArray<string>;
  }>;
};

export const arbTree = (options: { readonly extension: string }): fc.Arbitrary<Tree> => {
  const arbPath = fc
    .tuple(
      fc.array(fc.constantFrom(...FOLDERS), { minLength: 0, maxLength: 3 }),
      fc.constantFrom(...NAMES),
    )
    .map(([folders, name]) => ["src", ...folders, `${name}${options.extension}`].join("/"));

  return fc
    .uniqueArray(arbPath, { minLength: 5, maxLength: 40 })
    .chain((files) =>
      fc.tuple(
        fc.constant(files),
        fc.tuple(
          ...files.map((_, index) =>
            fc.record({
              local: fc.uniqueArray(
                fc.integer({ min: 0, max: files.length - 1 }).filter((other) => other !== index),
                { maxLength: 4 },
              ),
              external: fc.uniqueArray(fc.constantFrom(...EXTERNAL_SPECIFIERS), { maxLength: 2 }),
            }),
          ),
        ),
      ),
    )
    .map(([files, edges]) => ({ files, edges }));
};

export const specsOf = (tree: Tree, profile: Profile): Readonly<Record<string, FileSpec>> =>
  Object.fromEntries(
    tree.files.map((file, index) => {
      const edge = tree.edges[index] ?? { local: [], external: [] };
      const imports: ReadonlyArray<ImportSpec> = [
        ...edge.local.map((other) => profile.specifier(file, tree.files[other] ?? file)),
        ...edge.external,
      ];
      return [file, source({ imports, exports: ["value"] })];
    }),
  );

export const repoOf = (tree: Tree, profile?: Profile): Repo => {
  const repo = createRepo({ ...(profile === undefined ? {} : { profile }), packages: EXTERNALS });
  for (const [file, spec] of Object.entries(specsOf(tree, repo.profile))) repo.write(file, spec);
  return repo;
};

// A tight policy over `src/`: the tree may reach itself and nothing else, and
// nothing in it may import in a circle. Most generated trees violate it —
// which is what a property about violations needs.
export const tightManifest = (profile: Profile): Readonly<Record<string, unknown>> => ({
  resolve: { scopes: [profile.scope], unresolved: "error" },
  graph: {
    cycles: [{ name: "no-cycles", message: "These files import each other.", within: "src/**" }],
  },
  tree: {
    "src/": {
      message: "src/ may reach only itself.",
      layout: "open",
      imports: { message: "src/ may reach only itself.", allow: ["src/**"] },
      children: {},
    },
  },
});

// Runs per property, and the seed: overridable so a failure's seed can be
// replayed with `FC_SEED=<n> FC_NUM_RUNS=1`. Shrinking a forty-file tree is
// hundreds more runs of the bin; `FC_END_ON_FAILURE=1` skips it, and the time
// limit keeps a shrink from running a CI job into its own timeout.
export const parameters = <T>(): fc.Parameters<T> => ({
  numRuns: Number(process.env.FC_NUM_RUNS ?? "50"),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
  endOnFailure: process.env.FC_END_ON_FAILURE !== undefined,
  interruptAfterTimeLimit: 600_000,
  markInterruptAsFailure: true,
  verbose: true,
});

// A property that spawns the bin a few hundred times.
export const PROPERTY_TIMEOUT = 900_000;

// Every run of the bin is synchronous, and a property is minutes of them. A
// vitest worker that never yields cannot answer the main thread, which times
// out its progress reports at a minute; one tick per run keeps it answering.
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
