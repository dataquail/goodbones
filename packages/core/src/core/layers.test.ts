import { describe, expect, it } from "vitest";

import type { Atlas, AtlasEdge, AtlasFile, LayerMembership } from "../domain/atlas.js";
import { layerChainOf, layerViewOf, sliceOf } from "./layers.js";
import { renderMermaid } from "./mermaid.js";

// A module-shaped server, as the hexagon repository lays one out: two
// modules, each an `enclosing` layer holding io, application and domain
// tiers, and a platform tier outside any module. One command handler's slice
// runs endpoint → handler → command and domain root; the domain root's slice
// runs upward through both.

const REACH: AtlasFile["reach"] = {
  imports: true,
  structure: "open",
  members: false,
  surface: false,
  graph: true,
};

const at = (id: string, anchor: string): LayerMembership => ({ id, anchor });

const file = (path: string, layers: ReadonlyArray<LayerMembership>): AtlasFile => ({
  path,
  node: "src",
  layers,
  reach: REACH,
  external: false,
});

const ORG = "src/modules/organization";
const USER = "src/modules/user";
const inModule = (module: string, tier: string, path: string): AtlasFile =>
  file(path, [
    at("module", module),
    at(
      tier,
      `${module}/${tier === "io" ? "interface" : tier === "application" ? "commands" : "domain"}`,
    ),
  ]);

const edge = (from: string, to: string): AtlasEdge => ({
  from,
  to,
  status: "admitted",
  admittedBy: { node: "src", kind: "allow", entry: "src/**" },
});

export const LAYERED: Atlas = {
  version: 1,
  manifest: { path: "architecture.yaml", sha256: "abc" },
  roots: ["src"],
  layers: [
    { id: "module", type: "enclosing", message: "A bounded context." },
    { id: "io", type: "tier" },
    { id: "application", type: "tier" },
    { id: "domain", type: "tier" },
  ],
  nodes: [
    {
      path: "src/",
      name: "src",
      parent: null,
      kind: "folder",
      selector: "^src/",
      layout: "open",
      unrestricted: false,
      partial: false,
      families: ["imports"],
      allowances: [],
    },
  ],
  files: [
    file("src/server.ts", []),
    file("src/platform/cqrs/bus.ts", [at("application", "src/platform/cqrs")]),
    file("src/platform/ddd/entity.ts", [at("domain", "src/platform/ddd")]),
    file(`${ORG}/index.ts`, [at("module", ORG)]),
    inModule(ORG, "io", `${ORG}/interface/create-organization.endpoint.ts`),
    inModule(ORG, "application", `${ORG}/commands/create-organization.command.ts`),
    inModule(ORG, "application", `${ORG}/commands/create-organization.handler.ts`),
    inModule(ORG, "domain", `${ORG}/domain/organization.root.ts`),
    inModule(ORG, "domain", `${ORG}/domain/organization.repository.ts`),
    file(`${USER}/index.ts`, [at("module", USER)]),
    inModule(USER, "io", `${USER}/interface/create-user.endpoint.ts`),
    inModule(USER, "application", `${USER}/commands/create-user.handler.ts`),
    inModule(USER, "domain", `${USER}/domain/user.root.ts`),
  ],
  edges: [
    edge("src/server.ts", `${ORG}/index.ts`),
    edge("src/server.ts", `${USER}/index.ts`),
    edge("src/platform/cqrs/bus.ts", `${ORG}/index.ts`),
    edge(`${ORG}/index.ts`, `${ORG}/interface/create-organization.endpoint.ts`),
    edge(`${ORG}/index.ts`, `${ORG}/commands/create-organization.handler.ts`),
    edge(
      `${ORG}/interface/create-organization.endpoint.ts`,
      `${ORG}/commands/create-organization.command.ts`,
    ),
    edge(
      `${ORG}/interface/create-organization.endpoint.ts`,
      `${ORG}/commands/create-organization.handler.ts`,
    ),
    edge(
      `${ORG}/commands/create-organization.handler.ts`,
      `${ORG}/commands/create-organization.command.ts`,
    ),
    edge(`${ORG}/commands/create-organization.handler.ts`, `${ORG}/domain/organization.root.ts`),
    edge(
      `${ORG}/commands/create-organization.handler.ts`,
      `${ORG}/domain/organization.repository.ts`,
    ),
    edge(`${ORG}/domain/organization.root.ts`, "src/platform/ddd/entity.ts"),
    edge(`${ORG}/domain/organization.repository.ts`, `${ORG}/domain/organization.root.ts`),
    edge(`${ORG}/commands/create-organization.handler.ts`, "src/platform/cqrs/bus.ts"),
    edge(`${USER}/index.ts`, `${USER}/interface/create-user.endpoint.ts`),
    edge(`${USER}/interface/create-user.endpoint.ts`, `${USER}/commands/create-user.handler.ts`),
    edge(`${USER}/commands/create-user.handler.ts`, `${USER}/domain/user.root.ts`),
    edge(`${USER}/domain/user.root.ts`, "src/platform/ddd/entity.ts"),
    // A user endpoint reaching into organization's domain, across modules.
    edge(`${USER}/interface/create-user.endpoint.ts`, `${ORG}/domain/organization.root.ts`),
  ],
  designed: [],
  violations: [],
  cycles: [],
  unresolved: [],
};

const ids = (view: {
  members: ReadonlyArray<{ id: string; children?: ReadonlyArray<{ id: string }> }>;
}) => view.members.map((one) => [one.id, one.children?.map((child) => child.id) ?? []]);

describe("layerViewOf", () => {
  it("draws an enclosing layer as its members, with the edges between them rolled up", () => {
    const view = layerViewOf(LAYERED, "module");
    expect(view.focus).toBe("layer:module");
    expect(view.members.map((one) => [one.id, one.label, one.files])).toEqual([
      [ORG, "organization/", 6],
      [USER, "user/", 4],
    ]);
    expect(view.edges.map((one) => [one.from, one.to, one.count])).toEqual([[USER, ORG, 1]]);
  });

  it("draws a tier as its files, grouped by the enclosing member each sits in", () => {
    const view = layerViewOf(LAYERED, "io");
    expect(ids(view)).toEqual([
      [ORG, [`${ORG}/interface/create-organization.endpoint.ts`]],
      [USER, [`${USER}/interface/create-user.endpoint.ts`]],
    ]);
    expect(view.members[0]?.label).toBe("organization/");
    expect(view.members[0]?.children?.[0]?.layer).toBe("io");
    // No io file imports another, so there is nothing between them.
    expect(view.edges).toEqual([]);
  });

  it("puts a tier's files outside any enclosing layer under 'elsewhere'", () => {
    const view = layerViewOf(LAYERED, "application");
    expect(ids(view)).toEqual([
      [
        `${ORG}`,
        [
          `${ORG}/commands/create-organization.command.ts`,
          `${ORG}/commands/create-organization.handler.ts`,
        ],
      ],
      [`${USER}`, [`${USER}/commands/create-user.handler.ts`]],
      ["layer:application/elsewhere", ["src/platform/cqrs/bus.ts"]],
    ]);
    expect(view.members[2]?.label).toBe("elsewhere");
    expect(view.edges.map((one) => [one.from, one.to])).toEqual([
      [
        `${ORG}/commands/create-organization.handler.ts`,
        `${ORG}/commands/create-organization.command.ts`,
      ],
      [`${ORG}/commands/create-organization.handler.ts`, "src/platform/cqrs/bus.ts"],
    ]);
  });

  it("is empty for a layer the atlas does not declare", () => {
    expect(layerViewOf(LAYERED, "nope").members).toEqual([]);
  });
});

describe("sliceOf", () => {
  it("cuts a command handler's slice: the module and endpoint above, the command and domain below", () => {
    const view = sliceOf(LAYERED, `${ORG}/commands/create-organization.handler.ts`);
    expect(view.focus).toBe(`slice:${ORG}/commands/create-organization.handler.ts`);
    // One enclosing member, its layers in order; the platform files outside
    // any module in their own layer groups.
    expect(ids(view)).toEqual([
      [ORG, [`${ORG}::module`, `${ORG}::io`, `${ORG}::application`, `${ORG}::domain`]],
      ["layer:application", ["src/platform/cqrs/bus.ts"]],
      ["layer:domain", ["src/platform/ddd/entity.ts"]],
    ]);
    const org = view.members[0];
    expect(
      org?.children?.map((one) => [one.layer, one.children?.map((file) => file.label)]),
    ).toEqual([
      // The module's own files — its barrel — are the module layer, at the
      // top of the box; server.ts, in no layer, is where the cut stops.
      ["module", ["index.ts"]],
      ["io", ["create-organization.endpoint.ts"]],
      ["application", ["create-organization.command.ts", "create-organization.handler.ts"]],
      ["domain", ["organization.repository.ts", "organization.root.ts"]],
    ]);
    expect(JSON.stringify(view)).not.toContain("server.ts");
    // The user module's files are not in this slice: nothing reaches them.
    expect(JSON.stringify(view)).not.toContain("create-user");
    expect(view.edges.map((one) => `${one.from} → ${one.to}`)).toContain(
      `${ORG}/interface/create-organization.endpoint.ts → ${ORG}/commands/create-organization.handler.ts`,
    );
  });

  it("is exhaustive for a file many slices pass through", () => {
    const view = sliceOf(LAYERED, "src/platform/ddd/entity.ts");
    // Both modules reach it, so both modules are in the cut.
    expect(view.members.map((one) => one.id)).toEqual([ORG, USER, "layer:domain"]);
    expect(JSON.stringify(view)).toContain("create-user.endpoint.ts");
    expect(JSON.stringify(view)).toContain("create-organization.endpoint.ts");
  });

  it("never steps outward: an inner file's slice does not climb through an outer one", () => {
    // The user endpoint reaches organization's domain root; the root's slice
    // climbs to that endpoint (io is outer), but not from the endpoint back
    // down into the user handler (that is the endpoint's own slice).
    const view = sliceOf(LAYERED, `${ORG}/domain/organization.root.ts`);
    expect(JSON.stringify(view)).toContain("create-user.endpoint.ts");
    expect(JSON.stringify(view)).not.toContain("create-user.handler.ts");
  });

  it("is empty for a file no layer claims, or none the atlas has", () => {
    expect(sliceOf(LAYERED, "src/server.ts").members).toEqual([]);
    expect(sliceOf(LAYERED, "nope.ts").members).toEqual([]);
  });

  it("renders as mermaid like any view, nested three deep", () => {
    const text = renderMermaid(sliceOf(LAYERED, `${ORG}/commands/create-organization.handler.ts`));
    expect(text).toContain('  subgraph n_src_modules_organization["organization/"]');
    expect(text).toContain('    subgraph n_src_modules_organization_io["io"]');
    expect(text).toContain("n_src_modules_organization_interface_create_organization_endpoint_ts");
  });
});

describe("layerChainOf", () => {
  it("is the file's chain, outermost first, and empty for a file the atlas has not", () => {
    expect(layerChainOf(LAYERED, `${ORG}/domain/organization.root.ts`)).toEqual([
      { id: "module", anchor: ORG },
      { id: "domain", anchor: `${ORG}/domain` },
    ]);
    expect(layerChainOf(LAYERED, "nope.ts")).toEqual([]);
  });
});
