import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cli } from "../cli.js";
import { exports, imports } from "../profile.js";
import { createRepo, type Repo } from "../repo.js";

// The mermaid render, through the bin: the folder's children as nodes, the
// planted violation as the one thick edge, the ungoverned import dotted, the
// slack allowance a ghost when asked for, and the far end of an edge leaving
// the folder drawn as one node. Assertions are on the pairs the text names,
// never on layout — mermaid lays it out, and GitHub renders it.

let repo: Repo;

beforeAll(() => {
  repo = createRepo({
    packages: { effect: ["Effect"] },
    files: {
      "src/app/server.ts": imports("../domain/user.ts", "../infra/db.ts", "effect/Effect"),
      "src/domain/user.ts": imports("./order.ts"),
      // Planted: domain/ reaches infra/, which its allowlist refuses.
      "src/domain/order.ts": imports("../infra/db.ts"),
      "src/infra/db.ts": imports("node:fs"),
      // Under no node: its edge into src/ is ungoverned.
      "scripts/build.ts": imports("../src/app/server.ts"),
      "lib/legacy.ts": exports("legacy"),
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
          imports: {
            message: "Not on the allowlist.",
            allow: ["src/**", "node:**"],
            external: ["effect"],
          },
          children: {
            "domain/": {
              message: "domain/ is the model.",
              layout: "open",
              // `lib/**` is slack: domain/ may reach it, and nothing does.
              imports: {
                message: "domain/ reaches itself and lib/.",
                reset: true,
                allow: ["src/domain/**", "lib/**"],
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

describe("diagram", () => {
  it("draws the one walk root's children, with the planted violation as the thick edge", () => {
    const drawn = cli(repo, ["diagram", "src"]);
    expect(drawn.code, drawn.stderr).toBe(0);
    expect(drawn.stdout).toBe(
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

  it("draws an ungoverned edge dotted, from the repository root", () => {
    const drawn = cli(repo, ["diagram", "--root", ".", "src", "scripts"]);
    expect(drawn.code, drawn.stderr).toBe(0);
    expect(drawn.stdout).toContain("  n_scripts -.-> n_src\n");
    expect(drawn.stdout).toContain("  linkStyle 0 stroke:#f9a825\n");
  });

  it("draws the far end of an edge leaving the folder as one node, when asked", () => {
    const hidden = cli(repo, ["diagram", "--root", "src/domain", "src"]);
    expect(hidden.stdout).not.toContain("infra");
    const shown = cli(repo, ["diagram", "--root", "src/domain", "--outside", "src"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('  n_src_infra["../infra/"]\n');
    expect(shown.stdout).toContain("  n_src_domain_order_ts ==> n_src_infra\n");
    expect(shown.stdout).toContain("  class n_src_infra outside\n");
  });

  it("ghosts the slack allowance with --designed, and nests with --depth 2", () => {
    const ghosts = cli(repo, [
      "diagram",
      "--root",
      "src/domain",
      "--outside",
      "--designed",
      "src",
      "lib",
    ]);
    expect(ghosts.code, ghosts.stderr).toBe(0);
    expect(ghosts.stdout).toContain('  n_lib["../../lib/"]\n');
    expect(ghosts.stdout).toContain("  n_src_domain_order_ts -. designed .-> n_lib\n");
    expect(ghosts.stdout).toContain("  n_src_domain_user_ts -. designed .-> n_lib\n");

    const deep = cli(repo, ["diagram", "--depth", "2", "src"]);
    expect(deep.code, deep.stderr).toBe(0);
    expect(deep.stdout).toContain('  subgraph n_src_domain["domain/ ⚠ 1"]\n');
    expect(deep.stdout).toContain('    n_src_domain_order_ts["order.ts ⚠ 1"]\n');
    expect(deep.stdout).toContain("  n_src_domain_order_ts ==> n_src_infra_db_ts\n");
  });

  it("centres on the folder the --focus files share", () => {
    const focused = cli(repo, ["diagram", "--focus", "src/domain/user.ts", "src"]);
    expect(focused.code, focused.stderr).toBe(0);
    expect(focused.stdout).toContain("  n_src_domain_user_ts --> n_src_domain_order_ts\n");
    expect(focused.stdout).not.toContain("n_src_app");
  });

  it("refuses a folder holding no walked file", () => {
    const refused = cli(repo, ["diagram", "--root", "nowhere", "src"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("nothing to draw");
  });
});
