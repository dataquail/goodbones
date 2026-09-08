import { readdirSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cli } from "../cli.js";
import { imports } from "../profile.js";
import { createRepo, type Repo } from "../repo.js";

// The viewer written out, through the bin: `explore --out` copies the built
// bundle into a folder and inlines the atlas into its page, so the folder is
// the whole thing a static host needs. The server itself is not started here
// — a listening socket is not a scenario — its handling is tested in the CLI.

let repo: Repo;

beforeAll(() => {
  repo = createRepo({
    files: {
      "src/app/server.ts": imports("../domain/user.ts"),
      "src/domain/user.ts": imports("./order.ts"),
      "src/domain/order.ts": imports("../app/server.ts"),
    },
    manifest: {
      resolve: {
        scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }],
        unresolved: "off",
      },
      tree: {
        "src/": {
          message: "src/ is the program.",
          layout: "open",
          imports: { message: "Not on the allowlist.", allow: ["src/**"] },
          children: {
            "domain/": {
              layout: "open",
              imports: {
                message: "domain/ reaches only itself.",
                reset: true,
                allow: ["src/domain/**"],
              },
              children: {},
            },
            "**/": { layout: "open", children: {} },
          },
        },
      },
    },
  });
});

afterAll(() => {
  repo.dispose();
});

describe("explore --out", () => {
  it("writes the viewer with the atlas inlined into its page", () => {
    const written = cli(repo, ["explore", "--out", "site/atlas", "src"]);
    expect(written.code, written.stderr).toBe(0);
    expect(written.stdout).toContain("wrote the viewer with the atlas inlined to site/atlas/");

    expect(repo.exists("site/atlas/index.html")).toBe(true);
    expect(readdirSync(repo.path("site/atlas/assets")).some((one) => one.endsWith(".js"))).toBe(
      true,
    );

    const page = repo.read("site/atlas/index.html");
    const inlined = /<script id="goodbones-atlas" type="application\/json">(.*?)<\/script>/s.exec(
      page,
    )?.[1];
    expect(inlined).toBeDefined();
    const atlas = JSON.parse(inlined ?? "") as {
      readonly version: number;
      readonly edges: ReadonlyArray<{
        readonly from: string;
        readonly to: string;
        readonly status: string;
      }>;
      readonly cycles: ReadonlyArray<ReadonlyArray<string>>;
    };
    expect(atlas.version).toBe(1);
    expect(atlas.edges).toContainEqual({
      from: "src/domain/order.ts",
      to: "src/app/server.ts",
      status: "violation",
      violations: [expect.stringMatching(/^import\|src\/domain\/imports\|/)],
    });
    expect(atlas.cycles).toEqual([
      ["src/app/server.ts", "src/domain/order.ts", "src/domain/user.ts"],
    ]);
  });

  it("refuses a flag it does not know", () => {
    const refused = cli(repo, ["explore", "--watch", "src"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("unknown flag --watch");
  });
});
