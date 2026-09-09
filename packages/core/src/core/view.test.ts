import { describe, expect, it } from "vitest";

import type { Atlas, AtlasEdge, AtlasFile, AtlasNode } from "../domain/atlas.js";
import { focusOf, viewOf } from "./view.js";

// Twelve files across three tiers under `src/`, a `scripts/` folder no node
// governs, and a `lib/` nothing imports: one planted violation (domain/
// reaches infra/), one ungoverned import (scripts/ reaches app/), one cycle
// inside app/, and one slack allowance (domain/ may reach lib/, nothing does).
// The atlas is stated as data; the view is what these tests are about.

const REACHED: AtlasFile["reach"] = {
  imports: true,
  structure: "open",
  members: false,
  surface: false,
  graph: true,
};
const NONE: AtlasFile["reach"] = {
  imports: false,
  structure: null,
  members: false,
  surface: false,
  graph: false,
};

const file = (path: string, node: string | null, reach = REACHED): AtlasFile => ({
  path,
  node,
  reach,
  layers: [],
  external: false,
});
const external = (path: string): AtlasFile => ({
  path,
  node: null,
  layers: [],
  reach: NONE,
  external: true,
});

const node = (
  path: string,
  name: string,
  parent: string | null,
  selector: string,
  extra: Partial<AtlasNode> = {},
): AtlasNode => ({
  path,
  name,
  parent,
  kind: "folder",
  selector,
  layout: "open",
  unrestricted: false,
  partial: false,
  families: ["imports", "structure"],
  allowances: [],
  ...extra,
});

const admitted = (from: string, to: string, at: string, entry: string): AtlasEdge => ({
  from,
  to,
  status: "admitted",
  admittedBy: { node: at, kind: entry.startsWith("pkg") ? "external" : "allow", entry },
});

const VIOLATION = "import|src/domain/imports|src/domain/money.ts|src/infra/db.ts";

export const ATLAS: Atlas = {
  version: 1,
  manifest: { path: "architecture.yaml", sha256: "abc" },
  roots: ["src", "scripts", "lib"],
  layers: [],
  nodes: [
    node("src/", "src", null, "^src/", {
      message: "src/ is the program.",
      allowances: [
        { kind: "allow", entry: "src/**" },
        { kind: "external", entry: "effect" },
        { kind: "allow", entry: "node:**" },
      ],
    }),
    node("src/app/", "src/app", "src", "^src/app/", { message: "app/ composes." }),
    node("src/domain/", "src/domain", "src", "^src/domain/", {
      message: "domain/ is the model.",
      allowances: [{ kind: "allow", entry: "lib/**" }],
    }),
    node("src/infra/", "src/infra", "src", "^src/infra/", {
      message: "infra/ talks to the world.",
      unrestricted: true,
    }),
  ],
  files: [
    file("lib/legacy.ts", null, NONE),
    file("scripts/build.ts", null, NONE),
    file("scripts/release.ts", null, NONE),
    file("src/app/cli.ts", "src/app"),
    file("src/app/routes.ts", "src/app"),
    file("src/app/server.ts", "src/app"),
    file("src/domain/money.ts", "src/domain"),
    file("src/domain/order.ts", "src/domain"),
    file("src/domain/user.ts", "src/domain"),
    file("src/infra/db.ts", "src/infra"),
    file("src/infra/http.ts", "src/infra"),
    file("src/infra/mail.ts", "src/infra"),
    external("builtin:node:fs"),
    external("pkg:effect"),
  ],
  edges: [
    { from: "scripts/build.ts", to: "src/app/cli.ts", status: "ungoverned" },
    admitted("src/app/cli.ts", "src/app/server.ts", "src", "src/**"),
    admitted("src/app/routes.ts", "src/app/server.ts", "src", "src/**"),
    admitted("src/app/routes.ts", "src/domain/order.ts", "src", "src/**"),
    admitted("src/app/server.ts", "pkg:effect", "src", "effect"),
    admitted("src/app/server.ts", "src/app/routes.ts", "src", "src/**"),
    admitted("src/app/server.ts", "src/domain/user.ts", "src", "src/**"),
    admitted("src/app/server.ts", "src/infra/db.ts", "src", "src/**"),
    admitted("src/app/server.ts", "src/infra/http.ts", "src", "src/**"),
    {
      from: "src/domain/money.ts",
      to: "src/infra/db.ts",
      status: "violation",
      violations: [VIOLATION],
    },
    admitted("src/domain/order.ts", "src/domain/money.ts", "src", "src/**"),
    admitted("src/domain/order.ts", "src/domain/user.ts", "src", "src/**"),
    admitted("src/infra/db.ts", "builtin:node:fs", "src", "node:**"),
    admitted("src/infra/mail.ts", "src/domain/user.ts", "src", "src/**"),
  ],
  designed: [
    {
      node: "src",
      allowance: { kind: "allow", entry: "src/**" },
      targets: [
        "src/app/cli.ts",
        "src/app/routes.ts",
        "src/app/server.ts",
        "src/domain/money.ts",
        "src/domain/order.ts",
        "src/domain/user.ts",
        "src/infra/db.ts",
        "src/infra/http.ts",
        "src/infra/mail.ts",
      ],
      used: true,
    },
    {
      node: "src",
      allowance: { kind: "external", entry: "effect" },
      targets: ["pkg:effect"],
      used: true,
    },
    { node: "src", allowance: { kind: "allow", entry: "node:**" }, targets: [], used: true },
    {
      node: "src/domain",
      allowance: { kind: "allow", entry: "lib/**" },
      targets: ["lib/legacy.ts"],
      used: false,
    },
  ],
  violations: [
    {
      fingerprint: VIOLATION,
      kind: "import",
      ruleName: "src/domain/imports",
      file: "src/domain/money.ts",
      subject: "src/infra/db.ts",
      message: "domain/ reaches no adapter.",
      baselined: false,
    },
    {
      fingerprint: "graph|no-cycles|src/app/routes.ts|src/app/routes.ts ↔ src/app/server.ts",
      kind: "graph",
      ruleName: "no-cycles",
      file: "src/app/routes.ts",
      subject: "src/app/routes.ts ↔ src/app/server.ts",
      message: "These files import each other.",
      baselined: true,
    },
  ],
  cycles: [["src/app/routes.ts", "src/app/server.ts"]],
  unresolved: [],
};

const edgeOf = (view: ReturnType<typeof viewOf>, from: string, to: string) =>
  view.edges.find((one) => one.from === from && one.to === to);

describe("viewOf, one folder", () => {
  const view = viewOf(ATLAS, "src", { depth: 1, outside: "collapse", designed: false });

  it("has the focus's children as members, with their tier, files and badges", () => {
    expect(view.focus).toBe("src");
    expect(view.crumbs).toEqual(["", "src"]);
    expect(view.members.map((one) => [one.id, one.kind, one.label])).toEqual([
      ["src/app", "folder", "app/"],
      ["src/domain", "folder", "domain/"],
      ["src/infra", "folder", "infra/"],
    ]);
    expect(view.members[0]).toMatchObject({
      node: "src/app",
      message: "app/ composes.",
      files: 3,
      residue: 0,
      badges: { violations: 0, baselined: 1, cycles: 1, unrestricted: false, partial: false },
    });
    expect(view.members[1]?.badges).toEqual({
      violations: 1,
      baselined: 0,
      cycles: 0,
      unrestricted: false,
      partial: false,
    });
    expect(view.members[2]?.badges.unrestricted).toBe(true);
  });

  it("rolls the atlas edges up to one per pair, counted, dropping the ones within a member", () => {
    expect(view.edges.map((one) => [one.from, one.to, one.status, one.count])).toEqual([
      ["src/app", "pkg:effect", "admitted", 1],
      ["src/app", "src/domain", "admitted", 2],
      ["src/app", "src/infra", "admitted", 2],
      ["src/domain", "src/infra", "violation", 1],
      ["src/infra", "builtin:node:fs", "admitted", 1],
      ["src/infra", "src/domain", "admitted", 1],
    ]);
    expect(edgeOf(view, "src/app", "src/domain")?.underlying.map((one) => one.from)).toEqual([
      "src/app/routes.ts",
      "src/app/server.ts",
    ]);
  });

  it("carries the worst violation on the edge, with its message", () => {
    expect(edgeOf(view, "src/domain", "src/infra")?.worst).toEqual({
      fingerprint: VIOLATION,
      message: "domain/ reaches no adapter.",
    });
    expect(edgeOf(view, "src/app", "src/domain")?.worst).toBeNull();
  });

  it("collapses the far end of an edge leaving the focus onto a package or builtin", () => {
    expect(view.outside.map((one) => [one.id, one.kind, one.label])).toEqual([
      ["builtin:node:fs", "builtin", "node:fs"],
      ["pkg:effect", "package", "effect"],
    ]);
  });

  it("drops the edges leaving the focus with `outside: hide`", () => {
    const hidden = viewOf(ATLAS, "src", { depth: 1, outside: "hide", designed: false });
    expect(hidden.outside).toEqual([]);
    expect(hidden.edges.map((one) => `${one.from} ${one.to}`)).toEqual([
      "src/app src/domain",
      "src/app src/infra",
      "src/domain src/infra",
      "src/infra src/domain",
    ]);
  });
});

describe("viewOf, the roll-up's status", () => {
  it("is the worst of its parts", () => {
    // Widen: order.ts admitted into infra beside money.ts's violation.
    const widened: Atlas = {
      ...ATLAS,
      edges: [
        ...ATLAS.edges,
        admitted("src/domain/order.ts", "src/infra/http.ts", "src", "src/**"),
      ],
    };
    const edge = edgeOf(viewOf(widened, "src"), "src/domain", "src/infra");
    expect(edge).toMatchObject({ status: "violation", count: 2 });

    const root = viewOf(ATLAS, "");
    expect(root.members.map((one) => one.id)).toEqual(["lib", "scripts", "src"]);
    expect(edgeOf(root, "scripts", "src")).toMatchObject({ status: "ungoverned", count: 1 });
    expect(root.members[0]).toMatchObject({ node: null, residue: 1 });
  });
});

describe("viewOf, outside a folder", () => {
  it("names the nearest sibling of an ancestor, relative to the focus", () => {
    const app = viewOf(ATLAS, "src/app");
    expect(app.members.map((one) => one.id)).toEqual([
      "src/app/cli.ts",
      "src/app/routes.ts",
      "src/app/server.ts",
    ]);
    expect(app.outside.map((one) => [one.id, one.kind, one.label, one.files])).toEqual([
      ["pkg:effect", "package", "effect", 1],
      ["src/domain", "outside", "../domain/", 3],
      ["src/infra", "outside", "../infra/", 3],
    ]);
    expect(edgeOf(app, "src/app/server.ts", "src/domain")).toMatchObject({
      status: "admitted",
      count: 1,
    });
    // A self-edge within a file is nothing; the cycle is a badge.
    expect(app.members[1]?.badges.cycles).toBe(1);
  });
});

describe("viewOf, depth 2", () => {
  it("puts each member's children inside it and runs the edges between them", () => {
    const deep = viewOf(ATLAS, "src", { depth: 2, outside: "hide", designed: false });
    expect(deep.members.map((one) => one.children?.map((child) => child.id))).toEqual([
      ["src/app/cli.ts", "src/app/routes.ts", "src/app/server.ts"],
      ["src/domain/money.ts", "src/domain/order.ts", "src/domain/user.ts"],
      ["src/infra/db.ts", "src/infra/http.ts", "src/infra/mail.ts"],
    ]);
    expect(deep.edges.map((one) => `${one.from} ${one.to} ${one.status}`)).toEqual([
      "src/app/cli.ts src/app/server.ts admitted",
      "src/app/routes.ts src/app/server.ts admitted",
      "src/app/routes.ts src/domain/order.ts admitted",
      "src/app/server.ts src/app/routes.ts admitted",
      "src/app/server.ts src/domain/user.ts admitted",
      "src/app/server.ts src/infra/db.ts admitted",
      "src/app/server.ts src/infra/http.ts admitted",
      "src/domain/money.ts src/infra/db.ts violation",
      "src/domain/order.ts src/domain/money.ts admitted",
      "src/domain/order.ts src/domain/user.ts admitted",
      "src/infra/mail.ts src/domain/user.ts admitted",
    ]);
  });
});

describe("viewOf, designed edges", () => {
  it("draws an allowance nothing uses as a ghost edge where no observed edge runs", () => {
    const ghosts = viewOf(ATLAS, "src/domain", { depth: 1, outside: "collapse", designed: true });
    const designed = ghosts.edges.filter((one) => one.status === "designed");
    expect(designed.map((one) => `${one.from} ${one.to}`)).toEqual([
      "src/domain/money.ts lib",
      "src/domain/order.ts lib",
      "src/domain/user.ts lib",
    ]);
    expect(designed[0]).toMatchObject({ count: 0, worst: null, underlying: [] });
    expect(ghosts.outside.find((one) => one.id === "lib")).toMatchObject({
      kind: "outside",
      label: "../../lib/",
    });
    // Off by default: no ghost.
    expect(viewOf(ATLAS, "src/domain").edges.some((one) => one.status === "designed")).toBe(false);
  });

  it("draws nothing for an allowance some edge uses, nor over an observed pair", () => {
    const withGhosts = viewOf(ATLAS, "src", { depth: 1, outside: "collapse", designed: true });
    expect(edgeOf(withGhosts, "src/app", "src/domain")?.status).toBe("admitted");
    // `src/**` at `src` is used, so the pairs it would also permit — infra/
    // to app/, say — are not ghosted; only slack is.
    expect(edgeOf(withGhosts, "src/infra", "src/app")).toBeUndefined();
    expect(withGhosts.edges.filter((one) => one.status === "designed")).toEqual([
      expect.objectContaining({ from: "src/domain", to: "lib", status: "designed", count: 0 }),
    ]);
  });
});

describe("focusOf", () => {
  it("is the deepest folder every file is under", () => {
    expect(focusOf(ATLAS, ["src/app/server.ts"])).toBe("src/app");
    expect(focusOf(ATLAS, ["src/app/server.ts", "src/domain/user.ts"])).toBe("src");
    expect(focusOf(ATLAS, ["src/app/server.ts", "scripts/build.ts"])).toBe("");
    expect(focusOf(ATLAS, ["not/walked.ts"])).toBe("");
  });
});

describe("viewOf, a folder the atlas does not have", () => {
  it("is empty rather than an error", () => {
    expect(viewOf(ATLAS, "nowhere")).toEqual({
      focus: "nowhere",
      crumbs: ["", "nowhere"],
      members: [],
      outside: [],
      edges: [],
    });
  });
});
