import {
  type Language,
  type LoadedPolicy,
  loadPolicy,
  type ManifestLocator,
} from "@goodbones/core";
import {
  makeFactExtractorFake,
  makeFileSystemFake,
  makeModuleResolverFake,
} from "@goodbones/core/testing";
import * as Result from "effect/Result";

// A repository that does not exist, in a language that does not exist: a Go
// service with a domain and an adapter tier, one refused edge, one cycle, one
// external nobody uses, and a campaign over a JavaScript straggler. Every
// model test draws it, so the two browsers are proven against the same shape.

export const go = (): Language => ({
  id: "go",
  extensions: [".go"],
  ignoredFiles: [/_test\.go$/],
  packageMarkers: ["go.mod"],
  sourceRoots: [],
  extractor: makeFactExtractorFake({}),
  fixes: [],
  makeResolver: () =>
    Result.succeed(
      makeModuleResolverFake({
        "svc/main": "svc/main.go",
        "svc/domain/repo": "svc/domain/repo.go",
        "svc/domain/model": "svc/domain/model.go",
        "svc/adapters/pg": "svc/adapters/pg.go",
        pq: { kind: "external", path: "node_modules/pq/pq.go", package: "pq" },
        os: { kind: "builtin", path: "os" },
        "../../vendor.go": "vendor.go",
      }),
    ),
});

export const FILES = [
  "svc/main.go",
  "svc/domain/repo.go",
  "svc/domain/model.go",
  "svc/adapters/pg.go",
];

// Who imports what. `svc/adapters/pg.go` importing `svc/main` is the refused
// edge and closes the cycle; `svc/main.go`'s `./missing` resolves to nothing.
export const SPECIFIERS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "svc/main.go": ["svc/domain/repo", "svc/adapters/pg", "pq", "os", "./missing", "../../vendor.go"],
  "svc/domain/repo.go": ["svc/domain/model"],
  "svc/domain/model.go": [],
  "svc/adapters/pg.go": ["svc/domain/repo", "svc/main", "pq"],
};

export const factsOf = (file: string) => ({
  specifiers: SPECIFIERS[file] ?? [],
  bindings: new Map<string, never[]>(),
  memberSites: [],
  exportSites: [],
});

export const MANIFEST_TEXT = [
  "resolve:",
  "  scopes:",
  "    - files: ^svc/",
  "      language: go",
  "tree:",
  '  "svc/":',
  "    message: the service",
  "    imports:",
  "      allow: [svc/**, os]",
  "      external: [pq, unused-pkg]",
  "    children:",
  '      "main.go": {}',
  '      "domain/":',
  "        message: the domain",
  "        imports:",
  "          message: domain reaches itself",
  "          allow: [svc/domain/**]",
  "        children:",
  '          "*.go": { requires: ["{base}_test.go"] }',
  '      "adapters/":',
  "        imports:",
  "          reset: true",
  "          message: adapters reach the domain",
  "          allow: [svc/domain/**, svc/adapters/**]",
  "          external: [pq]",
  "        children:",
  '          "*.go": {}',
  "",
].join("\n");

export const manifest = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  resolve: { scopes: [{ files: "^svc/", language: "go" }] },
  baseline: ".architecture-baseline.json",
  graph: {
    cycles: [{ name: "no-cycles", message: "A cycle.", within: "svc/**" }],
  },
  tree: {
    "svc/": {
      message: "the service",
      imports: { allow: ["svc/**", "os"], external: ["pq", "unused-pkg"] },
      children: {
        "main.go": {},
        "domain/": {
          message: "the domain",
          imports: { message: "domain reaches itself", allow: ["svc/domain/**"] },
          children: { "*.go": { requires: ["{base}_test.go"] } },
        },
        "adapters/": {
          imports: {
            reset: true,
            message: "adapters reach the domain",
            allow: ["svc/domain/**", "svc/adapters/**"],
            external: ["pq"],
          },
          children: { "*.go": {} },
        },
      },
    },
  },
  ...extra,
});

// Positions as a YAML reader would answer them: the line each key of
// MANIFEST_TEXT was written on.
export const locate: ManifestLocator = (path) => {
  const key = path.map(String).join("/");
  const lines: Readonly<Record<string, number>> = {
    "tree/svc/": 6,
    "tree/svc//children/main.go": 12,
    "tree/svc//children/domain/": 13,
    "tree/svc//children/domain//children/*.go": 19,
    "tree/svc//children/adapters/": 20,
    "tree/svc//children/adapters//children/*.go": 27,
    "graph/cycles/0": 1,
  };
  const line = lines[key];
  return line === undefined ? null : { line, column: 1 };
};

export const unwrap = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

export const loadFixture = (
  input: Record<string, unknown> = manifest(),
  options: {
    readonly files?: ReturnType<typeof makeFileSystemFake>;
    readonly extensions?: Parameters<typeof loadPolicy>[0]["extensions"];
  } = {},
): LoadedPolicy =>
  unwrap(
    loadPolicy({
      repoRoot: "/repo",
      configPath: "/repo/architecture.yaml",
      manifest: input,
      locate,
      languages: [go()],
      fileSystem:
        options.files ?? makeFileSystemFake([...FILES, "svc/domain/repo_test.go", "vendor.go"]),
      extensions: options.extensions ?? [],
      now: Date.parse("2026-09-26T12:00:00.000Z"),
    }),
  );
