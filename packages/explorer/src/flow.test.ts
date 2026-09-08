import { viewOf } from "@goodbones/core";
import { describe, expect, it } from "vitest";

import { FIXTURE } from "./fixture.test.js";
import { edgeKey, flowOf, nodeKey, STATUS_COLOUR } from "./flow.js";
import { gridLayout } from "./layout.js";

describe("flowOf", () => {
  it("places every member and outside node where the layout put it", async () => {
    const view = viewOf(FIXTURE, "src");
    const layout = await gridLayout(view);
    const { edges, nodes } = flowOf(view, layout, null);
    expect(nodes.map((one) => one.id)).toEqual(["src/app", "src/domain", "pkg:effect"]);
    expect(nodes[0]).toMatchObject({
      type: "card",
      position: { x: 0, y: 0 },
      draggable: false,
      data: { selected: false, dimmed: false },
    });
    expect(nodes[1]?.position.x).toBeGreaterThan(0);
    expect(edges.map((one) => [one.source, one.target])).toEqual([
      ["src/app", "pkg:effect"],
      ["src/app", "src/domain"],
      ["src/domain", "pkg:effect"],
    ]);
  });

  it("colours an edge by its status, and marks the selected one", async () => {
    const view = viewOf(FIXTURE, "src");
    const layout = await gridLayout(view);
    const { edges, nodes } = flowOf(view, layout, {
      kind: "edge",
      from: "src/domain",
      to: "pkg:effect",
    });
    const refused = edges.find((one) => one.source === "src/domain");
    expect(refused?.style?.stroke).toBe(STATUS_COLOUR.violation);
    expect(refused?.selected).toBe(true);
    expect(refused?.id).toBe(edgeKey({ from: "src/domain", to: "pkg:effect" }));
    // The ends of the selected edge stay lit; the rest dims.
    expect(nodes.map((one) => [one.id, one.data.dimmed])).toEqual([
      ["src/app", true],
      ["src/domain", false],
      ["pkg:effect", false],
    ]);
  });

  it("nests a member's children under it at depth 2", async () => {
    const view = viewOf(FIXTURE, "src", { depth: 2, outside: "hide", designed: false });
    const layout = await gridLayout(view);
    const { nodes } = flowOf(view, layout, { kind: "node", id: "src/domain/user.ts" });
    expect(nodes.find((one) => one.id === "src/domain")?.type).toBe("folder");
    expect(nodes.find((one) => one.id === "src/domain/user.ts")).toMatchObject({
      type: "card",
      parentId: "src/domain",
      extent: "parent",
      data: { selected: true },
    });
    expect(nodeKey("src/domain/user.ts")).toBe("node:src/domain/user.ts");
  });

  it("labels a designed edge, and a counted one", async () => {
    const view = viewOf(FIXTURE, "src/domain", { depth: 1, outside: "collapse", designed: true });
    const layout = await gridLayout(view);
    const { edges } = flowOf(view, layout, null);
    expect(edges.map((one) => [one.source, one.target, one.label])).toEqual([
      ["src/domain/order.ts", "pkg:effect", undefined],
      ["src/domain/user.ts", "src/domain/order.ts", undefined],
    ]);
    // `vendor/**` matches nothing on disk, so there is nowhere for a ghost to
    // land: designed edges need a target the walk has.
    expect(edges.some((one) => one.data?.view.status === "designed")).toBe(false);
  });
});
