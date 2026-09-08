import { type Atlas, viewOf } from "@goodbones/core";
import { describe, expect, it } from "vitest";

import { FIXTURE } from "./fixture.test.js";
import { edgeId, highlightOf } from "./highlight.js";

// A reach violation with a route through the three files, and the cycle the
// route would be if it closed.
const ROUTE = ["src/app/server.ts", "src/domain/user.ts", "src/domain/order.ts"];

const ATLAS: Atlas = {
  ...FIXTURE,
  violations: [
    ...FIXTURE.violations,
    {
      fingerprint: "graph|app-reaches-no-order|src/app/server.ts|src/domain/order.ts",
      kind: "graph",
      ruleName: "app-reaches-no-order",
      file: "src/app/server.ts",
      subject: "src/domain/order.ts",
      message: "app/ reaches order.ts only through user.ts, and should not.",
      baselined: false,
      route: ROUTE,
    },
  ],
  cycles: [["src/domain/order.ts", "src/domain/user.ts"]],
};

describe("highlightOf", () => {
  it("traces a reach route as the units it crosses and the edges between them", () => {
    const view = viewOf(ATLAS, "src");
    const lit = highlightOf(ATLAS, view, {
      kind: "violation",
      fingerprint: "graph|app-reaches-no-order|src/app/server.ts|src/domain/order.ts",
    });
    expect(lit?.label).toBe("app-reaches-no-order: 2 hops");
    // Two of the three files roll up into domain/; the step within it is not
    // an edge the view draws.
    expect([...(lit?.nodes ?? [])]).toEqual(["src/app", "src/domain"]);
    expect([...(lit?.edges ?? [])]).toEqual([edgeId("src/app", "src/domain")]);
    expect(lit?.missing).toEqual([]);
  });

  it("traces the same route file by file when the focus is deeper", () => {
    const view = viewOf(ATLAS, "src/domain");
    const lit = highlightOf(ATLAS, view, {
      kind: "violation",
      fingerprint: "graph|app-reaches-no-order|src/app/server.ts|src/domain/order.ts",
    });
    // server.ts is outside the focus, and no edge leaves domain/ for app/, so
    // the view has no node for it: the panel names it instead.
    expect([...(lit?.nodes ?? [])].sort()).toEqual(["src/domain/order.ts", "src/domain/user.ts"]);
    expect([...(lit?.edges ?? [])]).toEqual([edgeId("src/domain/user.ts", "src/domain/order.ts")]);
    expect(lit?.missing).toEqual(["src/app/server.ts"]);
  });

  it("lights a cycle's members and the edges within the component", () => {
    const view = viewOf(ATLAS, "src/domain");
    const lit = highlightOf(ATLAS, view, { kind: "cycle", index: 0 });
    expect(lit?.label).toBe("cycle of 2 files");
    expect([...(lit?.nodes ?? [])].sort()).toEqual(["src/domain/order.ts", "src/domain/user.ts"]);
    expect([...(lit?.edges ?? [])]).toEqual([edgeId("src/domain/user.ts", "src/domain/order.ts")]);
  });

  it("names a file the view has no node for, rather than dropping it silently", () => {
    const hidden = viewOf(ATLAS, "src/domain", { depth: 1, outside: "hide", designed: false });
    const lit = highlightOf(ATLAS, hidden, {
      kind: "violation",
      fingerprint: "graph|app-reaches-no-order|src/app/server.ts|src/domain/order.ts",
    });
    expect(lit?.missing).toEqual(["src/app/server.ts"]);
  });

  it("lights an import violation's two ends, and nothing for a node or an unknown fingerprint", () => {
    const view = viewOf(ATLAS, "src");
    const lit = highlightOf(ATLAS, view, {
      kind: "violation",
      fingerprint: "import|src/domain/imports|src/domain/order.ts|node_modules/effect/index.js",
    });
    expect([...(lit?.nodes ?? [])]).toEqual(["src/domain"]);
    expect(highlightOf(ATLAS, view, { kind: "node", id: "src/app" })).toBeNull();
    expect(highlightOf(ATLAS, view, { kind: "violation", fingerprint: "nope" })).toBeNull();
    expect(highlightOf(ATLAS, view, { kind: "cycle", index: 9 })).toBeNull();
    expect(highlightOf(ATLAS, view, null)).toBeNull();
  });
});
