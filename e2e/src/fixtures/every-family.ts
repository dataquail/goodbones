import { exports, type FileContent, imports, type Profile, source } from "../profile.js";

// One planted violation per family, and one tree both hosts are run over: the
// CLI proves all six fire through the bin, and the plugin is held to the same
// per-file answer. Every fingerprint below is what `check --json` reports.

export const everyFamilyManifest = (profile: Profile): Readonly<Record<string, unknown>> => ({
  resolve: { scopes: [profile.scope], unresolved: "error" },
  graph: {
    cycles: [{ name: "no-cycles", message: "These files import each other.", within: "lib/**" }],
    orphans: [
      {
        name: "no-orphans",
        message: "Nothing imports this file.",
        within: "lib/**",
        entry: ["lib/main.ts"],
      },
    ],
    reach: [
      {
        name: "pure-reaches-no-adapter",
        message: "The pure tier reaches no adapter.",
        from: "src/pure/**",
        to: "src/adapters/**",
      },
    ],
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
      message: "src/ admits pure/, adapters/, ports/ and a view.",
      imports: { message: "src/ may reach only itself.", allow: ["src/**"] },
      children: {
        "pure/": { layout: "open", children: {} },
        "adapters/": { layout: "open", children: {} },
        "ports/": {
          message: "ports/ holds a *.repository.ts beside its -live.ts.",
          children: {
            "*.repository.ts": {
              message: "A port needs its adapter.",
              requires: ["{base}-live.ts"],
              members: [
                {
                  message: 'Port method "{name}" is not in the vocabulary.',
                  subject: "members",
                  declares: ["type"],
                  in: "*RepositoryShape",
                  allow: ["findOne"],
                },
              ],
            },
            "*-live.ts": {},
          },
        },
        "*.view.ts": {
          surface: [{ message: "A view exports nothing named.", kinds: ["named"] }],
          members: [
            {
              message: "`{name}` puts state in the View.",
              subject: "calls",
              match: "use[A-Z]*",
              allow: ["useAtomValue"],
            },
          ],
        },
      },
    },
  },
});

export const everyFamilyFiles: Readonly<Record<string, FileContent>> = {
  // graph/reach: the pure tier reaches an adapter.
  "src/pure/calc.ts": imports("../adapters/db.ts"),
  "src/adapters/db.ts": exports("db"),
  // imports: reaches outside src/.  exports: names a restricted factory.
  // members: a keyed finder.  structure: no thing.repository-live.ts.
  "src/ports/thing.repository.ts": source({
    imports: [{ from: "../../lib/bus.ts", names: ["makeBus"] }],
    declares: [{ type: "ThingRepositoryShape", members: ["findOneById"] }],
  }),
  // structure: a file ports/ does not admit.
  "src/ports/stray.ts": exports("stray"),
  // surface: a named export.  members: a stateful hook.
  "src/thing.view.ts": source({ exports: ["V"], declares: [{ calls: "useState" }] }),
  // graph/cycles: two files that import each other.  graph/orphans: a file
  // nothing imports, beside the entry that imports the rest.
  "lib/main.ts": imports("./a.ts"),
  "lib/a.ts": imports("./b.ts"),
  "lib/b.ts": imports("./a.ts"),
  "lib/orphan.ts": exports("orphan"),
  "lib/bus.ts": exports("makeBus"),
};

export const EVERY_FAMILY_ROOTS: ReadonlyArray<string> = ["src", "lib"];

export const everyFamilyFingerprints = {
  import: "import|src/imports|src/ports/thing.repository.ts|lib/bus.ts",
  export: "export|no-factories|src/ports/thing.repository.ts|lib/bus.ts#makeBus",
  memberDeclared:
    "member|src/ports/*.repository.ts/members-0|src/ports/thing.repository.ts|findOneById",
  memberCalled: "member|src/*.view.ts/members-0|src/thing.view.ts|useState",
  surface: "surface|src/*.view.ts/surface-0|src/thing.view.ts|V",
  parity:
    "structure|src/ports/*.repository.ts/requires|src/ports/thing.repository.ts|src/ports/thing.repository-live.ts",
  stray: "structure|src/ports/layout|src/ports/stray.ts|stray.ts",
  cycle: "graph|no-cycles|lib/a.ts|lib/a.ts ↔ lib/b.ts",
  orphan: "graph|no-orphans|lib/orphan.ts|",
  reach: "graph|pure-reaches-no-adapter|src/pure/calc.ts|src/adapters/db.ts",
} as const;
