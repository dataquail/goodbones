import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cli } from "../cli.js";
import { exports, imports } from "../profile.js";
import { createRepo, type Repo } from "../repo.js";

// The atlas, through the bin: every resolved edge with its status under the
// policy — a planted violation, an ungoverned file the allowlists never
// reach, a slack allowance nothing imports through — and the manifest's nodes
// with the file each is in, as one JSON document.

// The shape `atlas` prints, as far as this scenario reads it. Declared here
// rather than imported, since this is the contract under test.
type AtlasJson = {
  readonly version: 1;
  readonly manifest: { readonly path: string; readonly sha256: string };
  readonly roots: ReadonlyArray<string>;
  readonly nodes: ReadonlyArray<{
    readonly path: string;
    readonly name: string;
    readonly parent: string | null;
    readonly message?: string;
    readonly allowances: ReadonlyArray<{ readonly kind: string; readonly entry: string }>;
  }>;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly node: string | null;
    readonly external: boolean;
    readonly reach: { readonly imports: boolean };
  }>;
  readonly edges: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly status: "admitted" | "violation" | "ungoverned";
    readonly admittedBy?: { readonly node: string; readonly kind: string; readonly entry: string };
    readonly violations?: ReadonlyArray<string>;
  }>;
  readonly designed: ReadonlyArray<{
    readonly node: string;
    readonly allowance: { readonly kind: string; readonly entry: string };
    readonly targets: ReadonlyArray<string>;
    readonly used: boolean;
  }>;
  readonly violations: ReadonlyArray<{ readonly fingerprint: string }>;
  readonly cycles: ReadonlyArray<ReadonlyArray<string>>;
  readonly unresolved: ReadonlyArray<unknown>;
};

const atlas = (repo: Repo, argv: ReadonlyArray<string>) => {
  const result = cli(repo, ["atlas", ...argv]);
  let json: AtlasJson;
  try {
    json = JSON.parse(result.stdout) as AtlasJson;
  } catch (cause) {
    throw new Error(
      `atlas did not print one JSON object (exit ${String(result.code)}).\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\n${String(cause)}`,
    );
  }
  return { ...result, json };
};

let repo: Repo;

beforeAll(() => {
  repo = createRepo({
    packages: { effect: ["Effect"] },
    files: {
      "src/server.ts": imports("./domain/user.ts", "node:fs", "effect/Effect"),
      "src/domain/user.ts": imports("./order.ts"),
      // Planted: domain/ reaches effect, which its allowlist refuses.
      "src/domain/order.ts": imports("effect/Effect"),
      // Under no node: the policy has nothing to say about its edges.
      "scripts/build.ts": imports("../src/server.ts"),
      "lib/legacy.ts": exports("legacy"),
    },
    manifest: {
      resolve: {
        scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }],
        unresolved: "off",
      },
      graph: {
        cycles: [
          { name: "no-cycles", message: "These files import each other.", within: "src/**" },
        ],
      },
      tree: {
        "src/": {
          message: "src/ is the program.",
          layout: "open",
          // `vendor/**` is slack: nothing on disk, nothing imports through it.
          imports: {
            message: "Not on the allowlist.",
            allow: ["src/**", "node:**", "vendor/**"],
            external: ["effect"],
          },
          children: {
            // `reset` drops the inherited `effect`, so domain/ reaching it is
            // the planted violation.
            "domain/": {
              message: "domain/ reaches only itself.",
              layout: "open",
              imports: { message: "domain/ is the bottom.", reset: true, allow: ["src/domain/**"] },
              children: {},
            },
          },
        },
      },
    },
  });
});

afterAll(() => {
  repo.dispose();
});

describe("atlas", () => {
  it("prints one document naming the manifest and the roots", () => {
    const drawn = atlas(repo, ["src", "scripts"]);
    expect(drawn.code, drawn.stderr).toBe(0);
    expect(drawn.json.version).toBe(1);
    expect(drawn.json.manifest.path).toBe("architecture.yaml");
    expect(drawn.json.roots).toEqual(["src", "scripts"]);
    expect(drawn.json.unresolved).toEqual([]);
  });

  it("gives every resolved edge a status, externals as pseudo-files", () => {
    const { edges } = atlas(repo, ["src", "scripts"]).json;
    const status = (from: string, to: string) =>
      edges.find((one) => one.from === from && one.to === to);

    expect(status("src/server.ts", "src/domain/user.ts")).toEqual({
      from: "src/server.ts",
      to: "src/domain/user.ts",
      status: "admitted",
      admittedBy: { node: "src", kind: "allow", entry: "src/**" },
    });
    expect(status("src/server.ts", "pkg:effect")?.admittedBy).toEqual({
      node: "src",
      kind: "external",
      entry: "effect",
    });
    expect(status("src/server.ts", "builtin:node:fs")?.status).toBe("admitted");
    expect(status("src/domain/order.ts", "pkg:effect")).toMatchObject({
      status: "violation",
      violations: [
        expect.stringMatching(/^import\|src\/domain\/imports\|src\/domain\/order\.ts\|/),
      ],
    });
    // scripts/ is under no node, so its edge is resolved and ungoverned.
    expect(status("scripts/build.ts", "src/server.ts")).toEqual({
      from: "scripts/build.ts",
      to: "src/server.ts",
      status: "ungoverned",
    });
  });

  it("names each file's tier, and the nodes with what they wrote", () => {
    const { files, nodes } = atlas(repo, ["src", "scripts"]).json;
    const tier = (file: string) => files.find((one) => one.path === file)?.node;
    expect(tier("src/domain/user.ts")).toBe("src/domain");
    expect(tier("src/server.ts")).toBe("src");
    expect(tier("scripts/build.ts")).toBeNull();
    expect(files.find((one) => one.path === "pkg:effect")).toMatchObject({
      external: true,
      node: null,
    });
    expect(nodes.map((one) => [one.path, one.parent])).toEqual([
      ["src/", null],
      ["src/domain/", "src"],
    ]);
    expect(nodes[0]?.message).toBe("src/ is the program.");
    expect(nodes[0]?.allowances).toEqual([
      { kind: "allow", entry: "src/**" },
      { kind: "allow", entry: "node:**" },
      { kind: "allow", entry: "vendor/**" },
      { kind: "external", entry: "effect" },
    ]);
  });

  it("resolves every allowance against the walk, and marks the slack one unused", () => {
    const { designed } = atlas(repo, ["src", "scripts"]).json;
    const unused = designed.filter((one) => !one.used);
    expect(unused).toEqual([
      { node: "src", allowance: { kind: "allow", entry: "vendor/**" }, targets: [], used: false },
    ]);
    expect(
      designed.find((one) => one.node === "src/domain" && one.allowance.entry === "src/domain/**"),
    ).toEqual({
      node: "src/domain",
      allowance: { kind: "allow", entry: "src/domain/**" },
      targets: ["src/domain/order.ts", "src/domain/user.ts"],
      used: true,
    });
  });

  it("carries the violations and the cycles check would report", () => {
    const { cycles, violations } = atlas(repo, ["src"]).json;
    expect(cycles).toEqual([]);
    expect(violations.map((one) => one.fingerprint)).toEqual([
      expect.stringMatching(/^import\|src\/domain\/imports\|src\/domain\/order\.ts\|/),
    ]);
  });
});
