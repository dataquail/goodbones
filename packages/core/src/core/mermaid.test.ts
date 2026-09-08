import { describe, expect, it } from "vitest";

import { mermaidIdOf, renderMermaid } from "./mermaid.js";
import { viewOf } from "./view.js";
import { ATLAS } from "./view.test.js";

// The render is golden: a change here is a change to what every pull request
// comment and every document shows, and is reviewed as such.

describe("renderMermaid", () => {
  it("draws one folder: members as nodes, arrows by status, badges as suffixes", () => {
    expect(renderMermaid(viewOf(ATLAS, "src"))).toBe(
      `flowchart TB
  n_src_app["app/ ↻"]
  n_src_domain["domain/ ⚠ 1"]
  n_src_infra["infra/"]
  n_builtin_node_fs["node:fs"]
  n_pkg_effect["effect"]
  n_src_app --> n_pkg_effect
  n_src_app -- 2 --> n_src_domain
  n_src_app -- 2 --> n_src_infra
  n_src_domain ==> n_src_infra
  n_src_infra --> n_builtin_node_fs
  n_src_infra --> n_src_domain
  linkStyle 3 stroke:#c62828,stroke-width:2px
  classDef outside fill:none,stroke-dasharray:4 4,color:#666
  class n_builtin_node_fs,n_pkg_effect outside
`,
    );
  });

  it("draws an ungoverned edge dotted, and a designed one dotted and labelled", () => {
    const root = renderMermaid(viewOf(ATLAS, "", { depth: 1, outside: "hide", designed: false }));
    expect(root).toContain("  n_scripts -.-> n_src\n");
    expect(root).toContain("  linkStyle 0 stroke:#f9a825\n");

    const ghosts = renderMermaid(
      viewOf(ATLAS, "src/domain", { depth: 1, outside: "collapse", designed: true }),
    );
    expect(ghosts).toContain("  n_src_domain_money_ts -. designed .-> n_lib\n");
    expect(ghosts).toContain('  n_lib["../../lib/"]\n');
    expect(ghosts).toMatch(/linkStyle \d+ stroke:#9e9e9e/);
  });

  it("nests a member's children in a subgraph at depth 2", () => {
    const deep = renderMermaid(
      viewOf(ATLAS, "src", { depth: 2, outside: "hide", designed: false }),
    );
    expect(deep).toContain(
      `  subgraph n_src_app["app/ ↻"]
    n_src_app_cli_ts["cli.ts"]
    n_src_app_routes_ts["routes.ts ↻"]
    n_src_app_server_ts["server.ts ↻"]
  end
`,
    );
    expect(deep).toContain("  n_src_domain_money_ts ==> n_src_infra_db_ts\n");
    expect(deep).not.toContain("classDef");
  });

  it("names a node by its path, so a diff of two renders is a diff of the tree", () => {
    expect(mermaidIdOf("packages/core/src/domain")).toBe("n_packages_core_src_domain");
    expect(mermaidIdOf("pkg:@scope/name")).toBe("n_pkg_scope_name");
  });

  it("is just the header when there is nothing to draw", () => {
    expect(renderMermaid(viewOf(ATLAS, "nowhere"))).toBe("flowchart TB\n");
  });
});
