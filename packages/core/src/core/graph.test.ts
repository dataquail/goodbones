import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { GraphConfig } from "../domain/architecture-config.js";
import {
  compileGraphRules,
  evaluateGraph,
  type Graph,
  graphOf,
  graphRulesFailingTheirProbe,
  heightOf,
} from "./graph.js";

const compile = (config: GraphConfig) => {
  const compiled = compileGraphRules(config);
  if (Result.isFailure(compiled)) throw compiled.failure;
  return compiled.success;
};

// A graph from an edge list, with any extra lone files.
const graph = (
  edges: ReadonlyArray<readonly [string, string]>,
  files: ReadonlyArray<string> = [],
) => graphOf({ edges: edges.map(([a, b]) => [a, b] as const), files });

const found = (config: GraphConfig, at: Graph) =>
  evaluateGraph(compile(config), at).map(
    (violation) => `${violation.ruleName}:${violation.file}:${violation.subject ?? ""}`,
  );

const CYCLES: GraphConfig = {
  cycles: [
    {
      name: "no-cycles",
      message: "These files import each other.",
      probe: {
        edges: [
          ["src/a.ts", "src/b.ts"],
          ["src/b.ts", "src/a.ts"],
        ],
      },
      within: "^src/",
      withinNot: "\\.test\\.ts$",
    },
  ],
};

describe("cycles", () => {
  it("reports a strongly connected component once, as a sorted set", () => {
    const at = graph([
      ["src/b.ts", "src/c.ts"],
      ["src/c.ts", "src/a.ts"],
      ["src/a.ts", "src/b.ts"],
      ["src/a.ts", "src/leaf.ts"],
    ]);
    expect(found(CYCLES, at)).toEqual(["no-cycles:src/a.ts:src/a.ts ↔ src/b.ts ↔ src/c.ts"]);
  });

  it("keeps the same subject when an edge is added inside the cycle", () => {
    const before = graph([
      ["src/a.ts", "src/b.ts"],
      ["src/b.ts", "src/c.ts"],
      ["src/c.ts", "src/a.ts"],
    ]);
    const after = graph([
      ["src/a.ts", "src/b.ts"],
      ["src/b.ts", "src/c.ts"],
      ["src/c.ts", "src/a.ts"],
      ["src/a.ts", "src/c.ts"],
    ]);
    expect(found(CYCLES, before)).toEqual(found(CYCLES, after));
  });

  it("counts a file importing itself, and not a lone file", () => {
    expect(found(CYCLES, graph([["src/self.ts", "src/self.ts"]], ["src/lone.ts"]))).toEqual([
      "no-cycles:src/self.ts:src/self.ts",
    ]);
  });

  it("only sees the cycle through files within scope", () => {
    // The cycle runs through a test file, which the rule does not speak to.
    const at = graph([
      ["src/a.ts", "src/a.test.ts"],
      ["src/a.test.ts", "src/a.ts"],
    ]);
    expect(found(CYCLES, at)).toEqual([]);
  });

  it("reports two separate cycles separately", () => {
    const at = graph([
      ["src/a.ts", "src/b.ts"],
      ["src/b.ts", "src/a.ts"],
      ["src/x.ts", "src/y.ts"],
      ["src/y.ts", "src/x.ts"],
    ]);
    expect(found(CYCLES, at)).toEqual([
      "no-cycles:src/a.ts:src/a.ts ↔ src/b.ts",
      "no-cycles:src/x.ts:src/x.ts ↔ src/y.ts",
    ]);
  });
});

const ORPHANS: GraphConfig = {
  orphans: [
    {
      name: "no-orphans",
      message: "Nothing imports this file.",
      probe: { edges: [], files: ["src/lone.ts"] },
      within: "^src/",
      withinNot: "\\.test\\.ts$",
      entry: ["^src/main\\.ts$"],
    },
  ],
};

describe("orphans", () => {
  it("reports a file in scope that nothing imports, and not an entry", () => {
    const at = graph([["src/main.ts", "src/used.ts"]], ["src/lone.ts", "src/lone.test.ts"]);
    expect(found(ORPHANS, at)).toEqual(["no-orphans:src/lone.ts:"]);
  });

  it("counts an importer from outside the scope", () => {
    // A fake imported only by a test is not an orphan: the test imports it.
    const at = graph([["src/fake.test.ts", "src/fake.ts"]], ["src/main.ts"]);
    expect(found(ORPHANS, at)).toEqual([]);
  });
});

const REACH: GraphConfig = {
  reach: [
    {
      name: "through-the-port",
      message: "An adapter reaches infrastructure only through a port.",
      probe: { edges: [["src/adapters/a.ts", "src/infrastructure/live.ts"]] },
      from: "^src/adapters/",
      to: "^src/infrastructure/",
      via: "^src/ports/",
    },
  ],
};

describe("reach", () => {
  it("reports a target reached through any number of hops, with the route in the message", () => {
    const at = graph([
      ["src/adapters/a.ts", "src/helpers/h.ts"],
      ["src/helpers/h.ts", "src/infrastructure/live.ts"],
    ]);
    const [violation] = evaluateGraph(compile(REACH), at);
    expect(found(REACH, at)).toEqual([
      "through-the-port:src/adapters/a.ts:src/infrastructure/live.ts",
    ]);
    expect(violation?.message).toContain(
      "route: src/adapters/a.ts → src/helpers/h.ts → src/infrastructure/live.ts",
    );
  });

  it("allows a path that passes through `via`", () => {
    const at = graph([
      ["src/adapters/a.ts", "src/ports/p.ts"],
      ["src/ports/p.ts", "src/infrastructure/live.ts"],
    ]);
    expect(found(REACH, at)).toEqual([]);
  });

  it("reports each target once per origin, whichever route is shortest", () => {
    const at = graph([
      ["src/adapters/a.ts", "src/infrastructure/live.ts"],
      ["src/adapters/a.ts", "src/helpers/h.ts"],
      ["src/helpers/h.ts", "src/infrastructure/live.ts"],
    ]);
    expect(found(REACH, at)).toEqual([
      "through-the-port:src/adapters/a.ts:src/infrastructure/live.ts",
    ]);
  });
});

describe("graphRulesFailingTheirProbe", () => {
  it("passes rules that report their own probes", () => {
    expect(graphRulesFailingTheirProbe(compile({ ...CYCLES, ...ORPHANS, ...REACH }))).toEqual([]);
  });

  it("catches a cycle rule whose scope no longer includes its probe", () => {
    const drifted: GraphConfig = {
      cycles: [
        {
          ...(CYCLES.cycles?.[0] as NonNullable<GraphConfig["cycles"]>[number]),
          within: "^never/",
        },
      ],
    };
    expect(graphRulesFailingTheirProbe(compile(drifted))).toEqual(["no-cycles"]);
  });

  it("catches an orphan rule whose entries have widened to swallow its probe", () => {
    const drifted: GraphConfig = {
      orphans: [
        {
          ...(ORPHANS.orphans?.[0] as NonNullable<GraphConfig["orphans"]>[number]),
          entry: "^src/",
        },
      ],
    };
    expect(graphRulesFailingTheirProbe(compile(drifted))).toEqual(["no-orphans"]);
  });

  it("catches a reach rule whose `via` has widened to cover its own target", () => {
    const drifted: GraphConfig = {
      reach: [
        {
          ...(REACH.reach?.[0] as NonNullable<GraphConfig["reach"]>[number]),
          via: "^src/infrastructure/",
        },
      ],
    };
    expect(graphRulesFailingTheirProbe(compile(drifted))).toEqual(["through-the-port"]);
  });
});

describe("compileGraphRules", () => {
  it("refuses an uncompilable pattern", () => {
    const broken: GraphConfig = {
      cycles: [
        {
          ...(CYCLES.cycles?.[0] as NonNullable<GraphConfig["cycles"]>[number]),
          within: "^(unclosed",
        },
      ],
    };
    expect(Result.isFailure(compileGraphRules(broken))).toBe(true);
  });

  it("compiles an absent section to no rules", () => {
    expect(compile(undefined as unknown as GraphConfig)).toEqual({
      cycles: [],
      orphans: [],
      reach: [],
    });
  });
});

describe("heightOf", () => {
  it("measures each file's distance above a leaf", () => {
    const heights = heightOf(
      graph(
        [
          ["src/app.ts", "src/service.ts"],
          ["src/app.ts", "src/util.ts"],
          ["src/service.ts", "src/util.ts"],
        ],
        ["src/lone.ts"],
      ),
    );
    expect([...heights.entries()].sort()).toEqual([
      ["src/app.ts", 2],
      ["src/lone.ts", 0],
      ["src/service.ts", 1],
      ["src/util.ts", 0],
    ]);
  });

  it("gives the members of a cycle one height, and the file above it one more", () => {
    const cyclic = graph([
      ["src/a.ts", "src/b.ts"],
      ["src/b.ts", "src/a.ts"],
      ["src/b.ts", "src/leaf.ts"],
      ["src/c.ts", "src/a.ts"],
    ]);
    expect([...heightOf(cyclic).entries()].sort()).toEqual([
      ["src/a.ts", 1],
      ["src/b.ts", 1],
      ["src/c.ts", 2],
      ["src/leaf.ts", 0],
    ]);
  });
});
