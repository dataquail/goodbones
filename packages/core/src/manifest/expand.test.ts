import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import { expandManifest, originOf } from "./expand.js";

const unwrap = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(JSON.stringify(result.failure));

  return result.success;
};

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error("expected a failure");

  return result.failure;
};

const RULE = { message: "no fs", subject: "calls", match: ["*Sync"] };

describe("expandManifest", () => {
  it("passes a manifest with no defs through untouched", () => {
    const input = { resolve: { scopes: [] }, tree: { "src/": { children: {} } } };
    const expanded = unwrap(expandManifest(input));
    expect(expanded.value).toEqual(input);
    expect(expanded.substitutions).toEqual([]);
  });

  it("removes defs and $schema from what the decoder sees", () => {
    const expanded = unwrap(
      expandManifest({ $schema: "https://…", defs: { rule: RULE }, tree: {} }),
    );

    expect(expanded.value).toEqual({ tree: {} });
  });

  // Every position a rule object or a node may sit in: the expansion pass does
  // not know which, and replaces a reference wherever it stands.
  it.each([
    [
      "a members entry",
      { tree: { "src/": { members: [{ use: "rule" }] } } },
      ["tree", "src/", "members", 0],
    ],
    [
      "a surface entry",
      { tree: { "src/": { surface: [{ use: "rule" }] } } },
      ["tree", "src/", "surface", 0],
    ],
    ["an exports entry", { exports: [{ use: "rule" }] }, ["exports", 0]],
    [
      "a deny entry",
      { tree: { "src/": { imports: { deny: [{ use: "rule" }] } } } },
      ["tree", "src/", "imports", "deny", 0],
    ],
    ["a graph rule", { graph: { cycles: [{ use: "rule" }] } }, ["graph", "cycles", 0]],
    [
      "a whole imports object",
      { tree: { "src/": { imports: { use: "rule" } } } },
      ["tree", "src/", "imports"],
    ],
    [
      "a whole node",
      { tree: { "src/": { children: { "domain/": { use: "rule" } } } } },
      ["tree", "src/", "children", "domain/"],
    ],
  ])("replaces a reference standing as %s", (_, document, at) => {
    const expanded = unwrap(expandManifest({ defs: { rule: RULE }, ...document }));
    let cursor: unknown = expanded.value;

    for (const segment of at) cursor = (cursor as Record<PropertyKey, unknown>)[segment];
    expect(cursor).toEqual(RULE);
    expect(expanded.substitutions).toEqual([{ at, ref: at, name: "rule", overrides: new Set() }]);
  });

  it("copies a fragment, so two uses do not share one object", () => {
    const expanded = unwrap(
      expandManifest({ defs: { rule: RULE }, tree: { a: { use: "rule" }, b: { use: "rule" } } }),
    );

    const { tree } = expanded.value as { tree: { a: object; b: object } };
    expect(tree.a).toEqual(tree.b);
    expect(tree.a).not.toBe(tree.b);
    expect(tree.a).not.toBe(RULE);
  });

  it("shallow-merges the keys written beside `use` over the fragment", () => {
    const expanded = unwrap(
      expandManifest({
        defs: { rule: RULE },
        tree: { "src/": { members: [{ use: "rule", message: "louder", except: ["x"] }] } },
      }),
    );

    expect(
      (expanded.value as { tree: { "src/": { members: Array<unknown> } } }).tree["src/"].members,
    ).toEqual([{ ...RULE, message: "louder", except: ["x"] }]);
    expect(expanded.substitutions[0]?.overrides).toEqual(new Set(["message", "except"]));
  });

  it("does not deep-merge: an overriding list replaces the fragment's", () => {
    const expanded = unwrap(
      expandManifest({ defs: { rule: RULE }, tree: { x: { use: "rule", match: ["readFile"] } } }),
    );

    expect((expanded.value as { tree: { x: { match: unknown } } }).tree.x.match).toEqual([
      "readFile",
    ]);
  });

  it("expands a reference inside a fragment, and inside an override", () => {
    const expanded = unwrap(
      expandManifest({
        defs: {
          floor: { allow: ["node:**"] },
          imports: { message: "m", use: "floor" },
          node: { imports: { use: "imports" }, children: {} },
        },
        tree: { "src/": { use: "node" }, "lib/": { use: "node" } },
      }),
    ).value as { tree: Record<string, unknown> };

    expect(expanded.tree["lib/"]).toEqual({
      imports: { message: "m", allow: ["node:**"] },
      children: {},
    });
  });

  it("refuses a use of a name defs does not contain, listing the defined names", () => {
    const issue = failure(
      expandManifest({ defs: { a: {}, b: {} }, tree: { "src/": { members: [{ use: "c" }] } } }),
    );

    expect(issue.path).toEqual(["tree", "src/", "members", 0]);
    expect(issue.detail).toMatch(/`use: "c"` names no entry in `defs` \(defined: a, b\)/);
  });

  it("says when there are no defs at all", () => {
    const issue = failure(expandManifest({ tree: { "src/": { use: "c" } } }));
    expect(issue.detail).toMatch(/defines none/);
  });

  it("refuses a cycle, naming the chain", () => {
    const issue = failure(
      expandManifest({
        defs: { a: { use: "b" }, b: { x: { use: "c" } }, c: { use: "a" } },
        tree: { "src/": { use: "a" } },
      }),
    );

    expect(issue.detail).toMatch(/cycle: a → b → c → a/);
    expect(issue.path).toEqual(["defs", "c"]);
  });

  it("refuses overrides on a fragment that is not an object", () => {
    const issue = failure(
      expandManifest({
        defs: { globs: ["a", "b"] },
        tree: { "src/": { allow: { use: "globs", x: 1 } } },
      }),
    );

    expect(issue.detail).toMatch(/`defs.globs` is not an object/);
  });

  it("refuses defs that is not a map", () => {
    const issue = failure(expandManifest({ defs: [1], tree: {} }));
    expect(issue.path).toEqual(["defs"]);
  });
});

describe("originOf", () => {
  const document = {
    defs: {
      floor: { external: ["effect"], allow: ["node:**"] },
      node: { imports: { use: "floor", message: "m" }, children: {} },
    },
    tree: {
      "src/": { use: "node", layout: "open" },
      "lib/": { imports: { use: "floor" } },
    },
  };

  const { substitutions } = unwrap(expandManifest(document));

  it("maps a path outside any fragment to itself", () => {
    expect(originOf(substitutions, ["tree", "lib/"])).toEqual({ path: ["tree", "lib/"], via: [] });
  });

  it("maps a path inside a fragment to the fragment, via the use that pulled it in", () => {
    expect(originOf(substitutions, ["tree", "lib/", "imports", "allow", 0])).toEqual({
      path: ["defs", "floor", "allow", 0],
      via: [{ at: ["tree", "lib/", "imports"], name: "floor" }],
    });
  });

  it("follows a nested use, listing every reference outermost first", () => {
    expect(originOf(substitutions, ["tree", "src/", "imports", "external"])).toEqual({
      path: ["defs", "floor", "external"],
      via: [
        { at: ["tree", "src/"], name: "node" },
        { at: ["defs", "node", "imports"], name: "floor" },
      ],
    });
  });

  it("attributes an override to the site that wrote it, not the fragment", () => {
    expect(originOf(substitutions, ["tree", "src/", "imports", "message"])).toEqual({
      path: ["defs", "node", "imports", "message"],
      via: [{ at: ["tree", "src/"], name: "node" }],
    });
    expect(originOf(substitutions, ["tree", "src/", "layout"])).toEqual({
      path: ["tree", "src/", "layout"],
      via: [],
    });
  });
});
