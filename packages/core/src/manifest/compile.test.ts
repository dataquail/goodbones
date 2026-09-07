import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { ImportRule } from "../domain/architecture-config.js";
import { lowerManifest as lowerWith, type ProbeLanguage } from "./compile.js";
import { decodeManifest, type Manifest } from "./manifest.js";

// Every manifest below is a TypeScript one, so its synthetic probes are `.ts`
// files. The language is what says so; lowering itself never assumes it.
const TYPESCRIPT: ReadonlyArray<ProbeLanguage> = [
  { id: "typescript", extensions: [".ts", ".tsx"] },
];
const lowerManifest = (manifest: Manifest) => lowerWith(manifest, TYPESCRIPT);

const base = (tree: Manifest["tree"]): Manifest => ({
  resolve: {
    scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }],
  },
  aliases: { "@": "pkg/src" },
  tree,
});

const ruleNamed = <A extends { readonly name: string }>(
  rules: ReadonlyArray<A>,
  suffix: string,
): A => {
  const found = rules.find((rule) => rule.name.endsWith(suffix));
  if (found === undefined) throw new Error(`no rule ending in ${suffix}`);
  return found;
};

describe("multi-pattern keys", () => {
  const manifest = base({
    "@/domain/": {
      children: {
        "*.root.ts": {},
        "*.aggregate-ops.ts | *.entity-ops.ts | *.value-object-ops.ts": {
          message: "Constituent ops owe a sibling test.",
          requires: ["{base}.test.ts"],
        },
      },
    },
  });

  const lowered = lowerManifest(manifest);

  // The point of the feature: one node, one rule, every stereotype it names.
  it("emits one parity rule covering every alternative", () => {
    const parity = lowered.structure.parity;
    expect(parity).toHaveLength(1);
    const pattern = new RegExp(parity[0]?.file as string);
    expect(pattern.test("pkg/src/domain/todo.aggregate-ops.ts")).toBe(true);
    expect(pattern.test("pkg/src/domain/todo.entity-ops.ts")).toBe(true);
    expect(pattern.test("pkg/src/domain/todo.value-object-ops.ts")).toBe(true);
    expect(pattern.test("pkg/src/domain/todo.root.ts")).toBe(false);
  });

  it("admits every alternative in the folder's layout allowlist", () => {
    const folder = lowered.structure.folders[0];
    if (folder === undefined) throw new Error("no folder rule emitted");
    const admits = (basename: string) =>
      (folder.files as ReadonlyArray<string>).some((one) => new RegExp(one).test(basename));
    expect(admits("todo.aggregate-ops.ts")).toBe(true);
    expect(admits("todo.entity-ops.ts")).toBe(true);
    expect(admits("todo.value-object-ops.ts")).toBe(true);
    expect(admits("todo.helpers.ts")).toBe(false);
  });

  it("builds the probe from the first alternative, so the rule still proves itself", () => {
    expect(lowered.structure.parity[0]?.probe.path).toBe("pkg/src/domain/zz.aggregate-ops.ts");
  });

  // A capture has to come from one place, or the group numbering the IR relies
  // on stops meaning anything.
  it("refuses a key that both alternates and captures", () => {
    expect(() => lowerManifest(base({ "@/{a}/ | @/{b}/": { children: { "x.ts": {} } } }))).toThrow(
      /names several patterns and declares a capture/,
    );
  });
});

describe("sibling precedence", () => {
  // The nested config made this an ordering rule the author had to remember.
  // Here the tree shape already says it, so the compiler derives the exclusion.
  const lowered = lowerManifest(
    base({
      "@/domain/": {
        children: {
          "ports/": { children: { "*.client.ts": {} } },
          "domain-services/": { children: { "*.domain-service.ts": {} } },
          "{subdomain}/": { children: { "*.root.ts": {} } },
        },
      },
    }),
  );

  const subdomainFolder = ruleNamed(lowered.structure.folders, "/{subdomain}/layout");

  it("keeps a wildcard key from swallowing its literal siblings", () => {
    const pattern = new RegExp(subdomainFolder.folder as string);
    expect(pattern.test("pkg/src/domain/todo")).toBe(true);
    expect(pattern.test("pkg/src/domain/ports")).toBe(false);
    expect(pattern.test("pkg/src/domain/domain-services")).toBe(false);
  });
});

describe("importedBy", () => {
  const withAllow = (allow: ReadonlyArray<string>): Manifest =>
    base({
      "@/modules/{module}/": {
        children: {
          "*.root-ops.ts": {
            importedBy: { message: "Private to command handlers.", allow },
          },
        },
      },
    });

  it("compiles an allowlist that names no capture", () => {
    const lowered = lowerManifest(withAllow(["@/modules/*/commands/**"]));
    expect(ruleNamed(lowered.imports, "/imported-by").name).toContain("imported-by");
  });

  // The allowlist is matched against the IMPORTER, but the capture was declared
  // by the TARGET's path — so it would compile to a pattern that never matches
  // and the rule would over-report with an exemption that silently does nothing.
  it("refuses a capture, rather than emitting an exemption that cannot work", () => {
    expect(() => lowerManifest(withAllow(["@/modules/{module}/commands/**"]))).toThrow(
      /cannot be used there/,
    );
  });

  it("says which capture and what to do instead", () => {
    expect(() => lowerManifest(withAllow(["@/modules/{module}/commands/**"]))).toThrow(
      /\{module\}[\s\S]*Use a wildcard/,
    );
  });
});

describe("import policy scope", () => {
  const lowered = lowerManifest(
    base({
      "@/domain/": {
        imports: { message: "domain may only reach itself.", allow: ["@/domain/**"] },
        children: {
          "*.root.ts": {},
          "*.test.ts": { imports: { unrestricted: true } },
        },
      },
    }),
  );

  // Import policy is a property of a folder, so it lowers once per folder rather
  // than once per file kind in it.
  it("emits one rule for the folder, not one per file kind", () => {
    expect(lowered.imports.filter((rule) => rule.name.endsWith("/imports"))).toHaveLength(1);
  });

  it("exempts a file node that states its own policy from its folder's", () => {
    const folderRule = ruleNamed(lowered.imports, "/imports");
    const exemptions = (folderRule.fromNot ?? []) as ReadonlyArray<string>;
    expect(exemptions.some((one) => new RegExp(one).test("pkg/src/domain/todo.root.test.ts"))).toBe(
      true,
    );
    expect(exemptions.some((one) => new RegExp(one).test("pkg/src/domain/todo.root.ts"))).toBe(
      false,
    );
  });

  // A node that allows everything has no policy to prove, and emitting a rule
  // that can never report is the vacuity this package exists to prevent.
  it("emits nothing for a node whose allowlist admits everything", () => {
    expect(lowered.imports.some((rule) => rule.name.includes("*.test.ts"))).toBe(false);
  });
});

describe("external", () => {
  const lowered = lowerManifest(
    base({
      "@/domain/": {
        imports: {
          message: "domain/ reaches itself and the runtime.",
          external: ["effect", "@scope/name"],
          allow: ["@/domain/**"],
        },
        children: {
          "*.root.ts": {},
          "pure/": {
            imports: { message: "no runtime here.", reset: true, allow: ["@/domain/pure/**"] },
            children: { "*.ts": {} },
          },
          "adapters/": {
            imports: { message: "and the driver.", external: ["pg"], allow: ["@/domain/**"] },
            children: { "*.ts": {} },
          },
        },
      },
    }),
  );

  // The package is judged by its name and never by where the resolver found
  // it, so lowering carries the names through untouched — no path pattern is
  // written for an external.
  it("carries package names onto the rule, not a path pattern", () => {
    const rule = ruleNamed(lowered.imports, "domain/imports");
    expect(rule.externals).toEqual(["effect", "@scope/name"]);
    const toNot = (rule.toNot ?? []) as ReadonlyArray<string>;
    expect(toNot.some((one) => one.includes("node_modules"))).toBe(false);
  });

  it("inherits and accumulates down the tree, and reset drops the inheritance", () => {
    expect(ruleNamed(lowered.imports, "domain/adapters/imports").externals).toEqual([
      "effect",
      "@scope/name",
      "pg",
    ]);
    expect(ruleNamed(lowered.imports, "domain/pure/imports").externals).toBeUndefined();
  });

  // Each entry remembers where it was written, so a report can point at the
  // line no import uses. Aliases are expanded, the pattern is the `toNot`.
  it("records every allowance with the node that declared it", () => {
    const rule = ruleNamed(lowered.imports, "domain/adapters/imports");
    expect(rule.allowances).toEqual([
      { node: "domain", kind: "allow", entry: "pkg/src/domain/**", pattern: rule.toNot?.[0] },
      { node: "domain", kind: "external", entry: "effect" },
      { node: "domain", kind: "external", entry: "@scope/name" },
      {
        node: "domain/adapters",
        kind: "allow",
        entry: "pkg/src/domain/**",
        pattern: rule.toNot?.[1],
      },
      { node: "domain/adapters", kind: "external", entry: "pg" },
    ]);
    expect(ruleNamed(lowered.imports, "domain/pure/imports").allowances).toEqual([
      {
        node: "domain/pure",
        kind: "allow",
        entry: "pkg/src/domain/pure/**",
        pattern: expect.any(String) as string,
      },
    ]);
  });

  // A tier that names only its runtime has an allowlist — one that admits no
  // repository file at all.
  it("counts a node with externals and no allow as having an allowlist", () => {
    const runtimeOnly = lowerManifest(
      base({
        "@/scripts/": {
          layout: "open",
          children: {},
          imports: { message: "scripts reach only the runtime.", external: ["effect"] },
        },
      }),
    );
    const rule = ruleNamed(runtimeOnly.imports, "scripts/imports");
    expect(rule.externals).toEqual(["effect"]);
    expect(rule.toNot).toEqual([]);
  });
});

describe("reset", () => {
  const lowered = lowerManifest(
    base({
      "@/modules/{module}/": {
        imports: {
          allow: ["@/modules/{module}/**"],
          deny: [{ match: "**/*.test.ts", message: "Nothing imports a test file." }],
        },
        children: {
          "commands/": {
            imports: {
              reset: true,
              message: "commands see their own domain.",
              allow: ["@/modules/{module}/domain/**"],
            },
            children: { "*.handler.ts": {} },
          },
        },
      },
    }),
  );

  const commandsRule = ruleNamed(lowered.imports, "/commands/imports");

  it("drops the ancestor's allowances", () => {
    const allow = (commandsRule.toNot ?? []) as ReadonlyArray<string>;
    expect(allow.some((one) => one.includes("domain"))).toBe(true);
    // `@/modules/{module}/**` would have admitted queries/ and infrastructure/.
    expect(allow.some((one) => /\$1\/\.\*|\$1\(\/\.\*\)\?/.test(one))).toBe(false);
  });

  // A prohibition is emitted once, at the node that declares it, over that
  // node's whole subtree — so a descendant that resets its allowances is still
  // covered, and resetting can never make a subtree quieter than its ancestors.
  it("keeps the ancestor's prohibitions over the subtree", () => {
    const denial = ruleNamed(lowered.imports, "modules-module/deny-0");
    expect(denial.message).toBe("Nothing imports a test file.");
    expect(
      new RegExp(denial.from as string).test("pkg/src/modules/alpha/commands/do.handler.ts"),
    ).toBe(true);
  });

  it("does not restate an inherited prohibition at the descendant", () => {
    expect(lowered.imports.some((rule) => rule.name === "modules-module/commands/deny-0")).toBe(
      false,
    );
  });

  it("aims each denial's probe at the shape that denial names", () => {
    expect(ruleNamed(lowered.imports, "modules-module/deny-0").probe.to).toBe("deep/zz.test.ts");
  });
});

describe("unrestricted", () => {
  const manifest = base({
    "@/modules/{module}/": {
      imports: {
        unrestricted: true,
        deny: [{ match: "@/platform/**/*-live.ts", message: "Lives are wired at a root." }],
      },
      children: {
        "infrastructure/": {
          imports: {
            unrestricted: true,
            deny: [
              { match: "@/modules/*/interface/**", message: "No infrastructure to interface." },
            ],
          },
          children: { "*.repository-live.ts": {} },
        },
      },
    },
  });

  const lowered = lowerManifest(manifest);

  // Not tightening a tier is a decision; it should read as one.
  it("refuses an imports policy with no allowlist unless it says so", () => {
    expect(() =>
      lowerManifest(
        base({ "@/x/": { imports: { deny: [{ match: "**/*.test.ts", message: "no" }] } } }),
      ),
    ).toThrow(/say `unrestricted: true`/);
  });

  it("emits the prohibitions and no allowlist", () => {
    expect(lowered.imports.filter((rule) => rule.name.endsWith("/imports"))).toHaveLength(0);
    expect([...lowered.imports.map((rule) => rule.name)].sort()).toEqual([
      "modules-module/deny-0",
      "modules-module/infrastructure/deny-0",
    ]);
  });

  // Emitted once, over the whole subtree: a descendant neither restates it nor
  // can escape it, which is what makes `reset` unable to make a subtree quieter.
  it("scopes a prohibition to the subtree that declares it", () => {
    const rule = ruleNamed(lowered.imports, "modules-module/deny-0");
    const pattern = new RegExp(rule.from as string);
    expect(
      pattern.test("pkg/src/modules/alpha/infrastructure/repositories/x.repository-live.ts"),
    ).toBe(true);
    expect(rule.fromNot).toBeUndefined();
  });
});

describe("folder keys with alternatives", () => {
  // `"http/ | cli/"` carries a trailing slash on every alternative, so stripping
  // before splitting left `http/` with its slash and the folder never matched.
  const lowered = lowerManifest(
    base({ "@/interface/": { children: { "http/ | cli/": { children: { "index.ts": {} } } } } }),
  );

  it("governs every alternative folder", () => {
    const pattern = new RegExp(
      ruleNamed(lowered.structure.folders, "/http/layout").folder as string,
    );
    expect(pattern.test("pkg/src/interface/http")).toBe(true);
    expect(pattern.test("pkg/src/interface/cli")).toBe(true);
    expect(pattern.test("pkg/src/interface/events")).toBe(false);
  });
});

describe("requiresNot", () => {
  const lowered = lowerManifest(
    base({
      "@/http/": {
        children: {
          "*.endpoint.ts": {
            message: "Endpoints need an integration test.",
            requires: ["{base}.integration.test.ts"],
            requiresNot: ["login.endpoint.ts"],
          },
        },
      },
    }),
  );

  // The exemption sits on the obligation it exempts, rather than as a separate
  // more-specific key that has to win a precedence contest.
  it("exempts the filenames it names, and nothing else", () => {
    const rule = ruleNamed(lowered.structure.parity, "/requires");
    const exempt = (rule.fileNot ?? []) as ReadonlyArray<string>;
    expect(exempt.some((one) => new RegExp(one).test("pkg/src/http/login.endpoint.ts"))).toBe(true);
    expect(exempt.some((one) => new RegExp(one).test("pkg/src/http/create.endpoint.ts"))).toBe(
      false,
    );
  });
});

describe("prohibitions with exemptions", () => {
  const lowered = lowerManifest(
    base({
      "@/modules/{module}/": {
        imports: {
          unrestricted: true,
          deny: [
            {
              match: "@/modules/*/index.ts",
              matchNot: ["@/modules/{module}/index.ts"],
              except: ["@/modules/*/infrastructure/acl/**"],
              message: "Only an ACL adapter may name a foreign barrel.",
            },
          ],
        },
        children: {
          "infrastructure/": { children: { "acl/": { children: { "*.acl-live.ts": {} } } } },
        },
      },
    }),
  );

  const denial = ruleNamed(lowered.imports, "modules-module/deny-0");

  // The exemption is declared by the author of the prohibition, in the same
  // breath — a descendant still cannot opt itself out.
  it("exempts the importers the prohibition names", () => {
    const exempt = (denial.fromNot ?? []) as ReadonlyArray<string>;
    expect(
      exempt.some((one) =>
        new RegExp(one).test("pkg/src/modules/alpha/infrastructure/acl/beta.acl-live.ts"),
      ),
    ).toBe(true);
    expect(
      exempt.some((one) =>
        new RegExp(one).test(
          "pkg/src/modules/alpha/infrastructure/repositories/x.repository-live.ts",
        ),
      ),
    ).toBe(false);
  });

  // `{module}` resolves here because the prohibition's `from` side is this
  // node's own path, which is where the capture was declared.
  it("carves the importer's own module out of the target set", () => {
    const exceptions = (denial.toNot ?? []) as ReadonlyArray<string>;
    expect(exceptions[0]).toContain("$1");
  });
});

describe("importedBy on a folder", () => {
  const lowered = lowerManifest(
    base({
      "@/modules/{module}/": {
        importedBy: {
          message: "A module is private except through its barrel.",
          allow: ["@/modules/**"],
          matchNot: ["index.ts"],
        },
        imports: { unrestricted: true },
        children: { "index.ts": {}, "commands/": { children: { "*.handler.ts": {} } } },
      },
    }),
  );

  const rule = ruleNamed(lowered.imports, "/imported-by");

  // "A module is private" is a statement about everything under it, not about
  // the folder node itself.
  it("covers the whole subtree", () => {
    const target = new RegExp(rule.to as string);
    expect(target.test("pkg/src/modules/alpha/commands/do.handler.ts")).toBe(true);
    expect(target.test("pkg/src/modules/alpha/domain/one/one.root.ts")).toBe(true);
  });

  it("exempts the barrel it names, so the public surface stays public", () => {
    const exempt = (rule.toNot ?? []) as ReadonlyArray<string>;
    expect(exempt.some((one) => new RegExp(one).test("pkg/src/modules/alpha/index.ts"))).toBe(true);
    expect(
      exempt.some((one) => new RegExp(one).test("pkg/src/modules/alpha/commands/do.handler.ts")),
    ).toBe(false);
  });
});

describe("aliases", () => {
  it("expands an alias used as the whole pattern, not only as a prefix", () => {
    const lowered = lowerManifest({
      ...base({}),
      deny: [{ match: "@", message: "Nothing may reach the package root." }],
    });

    expect(ruleNamed(lowered.imports, "deny-0").to).toBe("^pkg/src");
  });
});

describe("a prohibition that carves targets back out", () => {
  it("lowers matchNot onto the rule's toNot", () => {
    const lowered = lowerManifest(
      base({
        "@/a/": {
          imports: {
            unrestricted: true,
            deny: [
              {
                match: "@/b/**",
                matchNot: "@/b/index.ts",
                message: "b/ is private except through its barrel.",
              },
            ],
          },
          children: { "*.ts": {} },
        },
      }),
    );

    expect(ruleNamed(lowered.imports, "a/deny-0").toNot).toEqual(["^pkg/src/b/index\\.ts"]);
  });
});

describe("export restrictions", () => {
  it("takes the first pattern of a multi-pattern module as the probe target", () => {
    const lowered = lowerManifest({
      ...base({}),
      exports: [
        {
          name: "no-factories",
          message: "A factory is built at a composition root.",
          module: ["**/node_modules/pkg/**", "**/node_modules/other/**"],
          symbols: ["makeBus"],
        },
      ],
    });

    expect(ruleNamed(lowered.exports, "no-factories").probe.to).toContain("node_modules/pkg");
  });

  it("carries an authored probe's source and symbol in place of the synthetic symbol", () => {
    const lowered = lowerManifest({
      ...base({}),
      exports: [
        {
          name: "no-factories",
          message: "A factory is built at a composition root.",
          module: "**/node_modules/pkg/**",
          symbols: ["makeBus"],
          probe: { source: 'import makeBus from "pkg";', symbol: "default" },
        },
      ],
    });

    const probe = ruleNamed(lowered.exports, "no-factories").probe;
    expect(probe.symbol).toBe("default");
    expect(probe.source).toBe('import makeBus from "pkg";');
    expect(probe.to).toContain("node_modules/pkg");
  });
});

describe("export restriction kinds", () => {
  const restriction = (kinds?: ReadonlyArray<"named" | "default" | "namespace">) =>
    lowerManifest({
      ...base({}),
      exports: [
        {
          name: "no-effect-barrel",
          message: "Import effect by subpath.",
          module: "**/node_modules/effect/**",
          ...(kinds === undefined ? {} : { kinds }),
        },
      ],
    });

  it("passes kinds through, and aims the synthetic probe at the first of them", () => {
    const rule = ruleNamed(restriction(["namespace", "named"]).exports, "no-effect-barrel");
    expect(rule.kinds).toEqual(["namespace", "named"]);
    expect(rule.probe.kind).toBe("namespace");
    expect(rule.probe.symbol).toBe("*");
  });

  it("names a default probe `default`", () => {
    const rule = ruleNamed(restriction(["default"]).exports, "no-effect-barrel");
    expect(rule.probe).toMatchObject({ kind: "default", symbol: "default" });
  });

  it("leaves kinds unset — the core's default of named — when the manifest says nothing", () => {
    const rule = ruleNamed(restriction().exports, "no-effect-barrel");
    expect(rule.kinds).toBeUndefined();
    expect(rule.probe.kind).toBe("named");
  });
});

describe("surface rules", () => {
  const lowered = (spec: Record<string, unknown>) =>
    lowerManifest(
      base({
        "@/handlers/": {
          layout: "open",
          children: {},
          surface: [spec as never],
        },
      }),
    ).surface[0];

  it("covers the subtree, and defaults to forbid with a probe of one selected site", () => {
    const rule = lowered({ message: "No default exports.", kinds: ["default"] });
    expect(new RegExp(rule?.from as string).test("pkg/src/handlers/deep/x.ts")).toBe(true);
    expect(rule?.probe.sites).toEqual([{ name: "default", kind: "default" }]);
    expect(rule?.allow).toBeUndefined();
    expect(rule?.count).toBeUndefined();
  });

  it("lowers a named convention to its regex, with a name the convention rejects as the probe", () => {
    const rule = lowered({ message: "camelCase.", convention: "camelCase" });
    expect(rule?.convention).toBe("^[a-z][a-zA-Z0-9]*$");
    expect(rule?.probe.sites?.[0]?.name).toBe("zz-probe-stray");
  });

  it("probes a minimum count with an empty surface, and a maximum with one site too many", () => {
    expect(lowered({ message: "one", count: { min: 1, max: 1 } })?.probe.sites).toEqual([]);
    expect(lowered({ message: "two", count: { max: 2 } })?.probe.sites).toHaveLength(3);
  });

  it("refuses a count nothing can violate", () => {
    expect(() => lowered({ message: "any", count: {} })).toThrow(/nothing can violate/);
  });

  it("refuses more than one demand on one entry", () => {
    expect(() => lowered({ message: "x", allow: ["a"], count: { max: 1 } })).toThrow(/one demand/);
  });

  it("carries an authored probe's source and `except` as fromNot", () => {
    const rule = lowered({
      message: "x",
      kinds: ["default"],
      except: ["@/handlers/main.ts"],
      probe: { source: "export default 1;" },
    });
    expect(rule?.probe.source).toBe("export default 1;");
    const [exempt] = rule?.fromNot ?? [];
    expect(exempt).toBeDefined();
    expect(new RegExp(exempt ?? "").test("pkg/src/handlers/main.ts")).toBe(true);
  });
});

describe("graph rules", () => {
  const lowered = lowerManifest({
    ...base({}),
    graph: {
      cycles: [{ name: "no-cycles", message: "…", within: "@/**", withinNot: "**/*.test.ts" }],
      orphans: [{ name: "no-orphans", message: "…", within: "@/**", entry: "@/index.ts" }],
      reach: [
        {
          name: "via-ports",
          message: "…",
          from: "@/adapters/**",
          to: "@/infra/**",
          via: "@/ports/**",
        },
      ],
    },
  });

  it("expands aliases in every scope and builds a two-node cycle as the probe", () => {
    const [rule] = lowered.graph.cycles ?? [];
    expect(new RegExp(rule?.within[0] ?? "").test("pkg/src/a.ts")).toBe(true);
    expect(new RegExp(rule?.withinNot?.[0] ?? "").test("pkg/src/a.test.ts")).toBe(true);
    expect(rule?.probe.edges).toHaveLength(2);
    expect(rule?.probe.edges[0]?.[0]).toMatch(/^pkg\/src\//);
  });

  it("probes an orphan rule with a lone file in scope", () => {
    const [rule] = lowered.graph.orphans ?? [];
    expect(rule?.probe.edges).toEqual([]);
    expect(rule?.probe.files?.[0]).toMatch(/^pkg\/src\/.*zz-orphan\.ts$/);
    expect(new RegExp(rule?.entry[0] ?? "").test("pkg/src/index.ts")).toBe(true);
  });

  it("probes a reach rule with a direct edge that touches no via", () => {
    const [rule] = lowered.graph.reach ?? [];
    const [edge] = rule?.probe.edges ?? [];
    expect(edge?.[0]).toMatch(/^pkg\/src\/adapters\//);
    expect(edge?.[1]).toMatch(/^pkg\/src\/infra\//);
    expect(new RegExp(rule?.via?.[0] ?? "").test("pkg/src/ports/p.ts")).toBe(true);
  });

  it("lowers to no graph rules when the manifest has no graph section", () => {
    expect(lowerManifest(base({})).graph).toEqual({ cycles: [], orphans: [], reach: [] });
  });
});

describe("adoption", () => {
  it("lists the nodes that said unrestricted or partial, by name", () => {
    const lowered = lowerManifest(
      base({
        "@/legacy/": {
          layout: "open",
          children: {},
          imports: { message: "…", unrestricted: true },
        },
        "@/wip/": { partial: true, children: { "*.ts": {} } },
        "@/done/": {
          layout: "open",
          children: {},
          imports: { message: "…", allow: ["@/done/**"] },
        },
      }),
    );
    expect(lowered.adoption).toEqual({ unrestricted: ["legacy"], partial: ["wip"] });
  });
});

describe("member rules", () => {
  it("covers the subtree when stated on a folder, as imports does", () => {
    const lowered = lowerManifest(
      base({
        "@/core/": {
          layout: "open",
          children: {},
          members: [{ message: "core reads no file.", subject: "calls", match: "readFileSync" }],
        },
      }),
    );

    const [rule] = lowered.members;
    const from = new RegExp(rule?.from as string);
    expect(from.test("pkg/src/core/imports.ts")).toBe(true);
    expect(from.test("pkg/src/core/deep/nested.ts")).toBe(true);
    expect(from.test("pkg/src/domain/x.ts")).toBe(false);
    expect(from.test(rule?.probe.from as string)).toBe(true);
  });

  it("carries an authored probe's source and name, and drops the synthetic `in`", () => {
    const lowered = lowerManifest(
      base({
        "@/domain/": {
          children: {
            "*.repository.ts": {
              members: [
                {
                  message: "Not in the vocabulary.",
                  subject: "members",
                  declares: ["type", "interface"],
                  in: "*RepositoryShape",
                  allow: ["findOne"],
                  probe: {
                    source: "export type X = { findOneById(): void };",
                    name: "findOneById",
                  },
                },
              ],
            },
          },
        },
      }),
    );

    const [rule] = lowered.members;
    expect(rule?.probe.name).toBe("findOneById");
    expect(rule?.probe.source).toBe("export type X = { findOneById(): void };");
    expect(rule?.probe.in).toBeUndefined();
    expect(rule?.probe.from).toMatch(/\.repository\.ts$/);
    expect(rule?.declares).toEqual(["type", "interface"]);
  });

  // The synthetic probe must be a site the rule speaks to, so it is declared
  // in the first kind the rule names.
  it("declares the synthetic probe in the first kind the rule names", () => {
    const lowered = lowerManifest(
      base({
        "@/domain/": {
          layout: "open",
          children: {},
          members: [
            { message: "…", subject: "members", declares: ["class", "interface"], in: "*Shape" },
          ],
        },
      }),
    );
    expect(lowered.members[0]?.probe.declares).toBe("class");
  });
});

describe("naming", () => {
  const tree = (name: unknown, extra: Record<string, unknown> = {}) =>
    lowerManifest(
      base({
        "@/modules/{module}/": {
          name,
          children: {
            "domain/{subdomain}/": {
              children: { "*.root.ts": extra, "*.id.ts": {} },
            },
          },
        },
      } as never),
    );

  it("judges a folder's own segment where its key declares a capture", () => {
    const rule = ruleNamed(tree("kebab-case").structure.naming, "modules-module/naming-folder");
    expect(rule.convention).toBe("^[a-z0-9]+(?:-[a-z0-9]+)*$");
    expect(rule.file[0]).toContain("pkg/src/modules");
  });

  // A literal key names nothing variable, so it has no segment to judge — only
  // the files inside it.
  it("emits no folder rule for a key with no variable segment", () => {
    const names = tree("kebab-case").structure.naming.map((rule) => rule.name);
    expect(names).not.toContain("modules-module/domain/{subdomain}/*.root.ts/naming-folder");
  });

  // Inheritance is the whole ergonomics: one declaration, not one per key.
  it("carries the convention down to a folder that does not restate it", () => {
    const names = tree("kebab-case").structure.naming.map((rule) => rule.name);
    expect(names).toContain("modules-module/domain/{subdomain}/naming");
  });

  it("states nothing when no tier declares a convention", () => {
    expect(tree(undefined).structure.naming).toEqual([]);
  });

  describe("named after an ancestor capture", () => {
    it("compiles to a comparison between two groups of one match", () => {
      const rule = ruleNamed(
        tree("kebab-case", { name: { like: "{subdomain}" } }).structure.naming,
        "*.root.ts/naming",
      );
      expect(rule.sameAs).toBeDefined();
      expect(rule.subject).not.toBe(rule.sameAs);
    });

    it("refuses a reference no ancestor path declares", () => {
      expect(() => tree("kebab-case", { name: { like: "{nowhere}" } })).toThrow(/no ancestor/);
    });
  });

  // A convention nothing can violate is a rule that never reports, which is the
  // one failure this package refuses to ship.
  it("refuses a custom pattern that admits every name", () => {
    expect(() => tree({ regex: ".*" })).toThrow(/admits every name/);
  });

  it("generates a probe its own convention rejects", () => {
    const rule = ruleNamed(tree("PascalCase").structure.naming, "modules-module/naming");
    expect(rule.probe.path).toMatch(/zz-probe-stray/);
  });
});

describe("naming edge cases", () => {
  const one = (node: unknown) => lowerManifest(base({ "@/a/": node } as never)).structure.naming;

  it("refuses a convention it does not know", () => {
    expect(() => one({ name: "SCREAMING_SNAKE", children: { "*.ts": {} } })).toThrow(
      /unknown naming convention/,
    );
  });

  it("carries a custom message rather than the generated one", () => {
    const [rule] = one({
      name: { regex: "^x[a-z]+$", message: "A file here starts with x." },
      children: { "*.ts": {} },
    });
    expect(rule?.message).toBe("A file here starts with x.");
  });

  it.each(["camelCase", "snake_case"])("knows the shape of %s", (convention) => {
    const [rule] = one({ name: convention, children: { "*.ts": {} } });
    expect(rule?.message).toContain(convention);
    expect(rule?.convention).toBeDefined();
  });
});

describe("probe files and the language", () => {
  const GO: ReadonlyArray<ProbeLanguage> = [{ id: "go", extensions: [".go"] }];
  const goManifest: Manifest = {
    resolve: { scopes: [{ files: "^svc/", language: "go" }] },
    graph: {
      orphans: [{ name: "no-orphans", message: "…", within: "svc/**", entry: "svc/main.go" }],
    },
    tree: {
      "svc/": {
        children: {
          "main.go": {},
          "domain/": {
            imports: { message: "domain reaches itself.", allow: ["svc/domain/**"] },
            children: { "*.go": {} },
          },
        },
      },
    },
  };
  const lowered = lowerWith(goManifest, GO);

  // The whole point: nothing in lowering spells `.ts`. A scope in another
  // language gets probes that are files of that language.
  it("writes every synthetic probe as a file of the scope's language", () => {
    expect(ruleNamed(lowered.imports, "svc/domain/imports").probe.from).toBe(
      "svc/domain/zzprobe.go",
    );
    // The target the allowlist must refuse is a file of the importer's own
    // language — an allowlist admitting `**/*.go` would otherwise pass its
    // probe while admitting every Go file.
    expect(ruleNamed(lowered.imports, "svc/domain/imports").probe.to).toBe(
      "packages/zzprobe/nowhere.go",
    );
    expect(ruleNamed(lowered.structure.roots, "svc/taxonomy").probe.path).toBe(
      "svc/zzprobe/stray.go",
    );
    expect(lowered.graph.orphans?.[0]?.probe.files).toEqual(["svc/deep/zz-orphan.go"]);
  });

  it("proves a folder's layout with a basename the folder rejects", () => {
    const domain = ruleNamed(lowered.structure.folders, "svc/domain/layout");
    const admitted = (basename: string) =>
      (domain.files as ReadonlyArray<string>).some((one) => new RegExp(one).test(basename));
    const stray = domain.probe.path.split("/").pop() ?? "";
    expect(admitted("thing.go")).toBe(true);
    expect(admitted(stray)).toBe(false);
  });

  // A folder that admits every `.ts` file still rejects a `.js` one, so it
  // states a policy — and its probe has to be a name it rejects, which
  // `zzprobe-stray.ts` is not.
  it("proves a folder whose children are `*.ts` with a name outside that shape", () => {
    const one = lowerManifest(base({ "@/lib/": { children: { "*.ts": {} } } }));
    const rule = ruleNamed(one.structure.folders, "lib/layout");
    expect(rule.probe.path).toBe("pkg/src/lib/zzprobe-stray");
  });

  it("refuses a folder that admits every name without saying `layout: open`", () => {
    expect(() => lowerManifest(base({ "@/lib/": { children: { "*": {} } } }))).toThrow(
      /admits every file name/,
    );
  });

  it("gives a probe no extension where no scope's language is known", () => {
    const unknown = lowerWith(base({ "@/lib/": { children: { "*.ts": {} } } }), []);
    expect(ruleNamed(unknown.structure.roots, "@/lib/taxonomy").probe.path).toBe(
      "pkg/src/lib/zzprobe/stray",
    );
  });

  // A graph scope may name a file shape rather than a folder; the probe is
  // then a file of that shape, not a file beneath it.
  it("fills a file-shaped graph scope in place, keeping its extension", () => {
    const one = lowerManifest({
      ...base({}),
      graph: {
        cycles: [{ name: "c", message: "…", within: "@/**/*.ts" }],
        reach: [{ name: "r", message: "…", from: "@/a/*.root.ts", to: "@/b/**" }],
      },
    });
    expect(one.graph.cycles?.[0]?.probe.edges[0]).toEqual([
      "pkg/src/deep/zz-alpha.ts",
      "pkg/src/deep/zz-beta.ts",
    ]);
    expect(one.graph.reach?.[0]?.probe.edges[0]).toEqual([
      "pkg/src/a/zz-origin.root.ts",
      "pkg/src/b/deep/zz-target.ts",
    ]);
  });
});

describe("allowance provenance", () => {
  // Through the decoder, since the substitutions it records are what say
  // which `use` carried a value — lowering the decoded tree alone would read
  // every entry as authored where it sits. Raw input, as a file would give it.
  const lowerRaw = (raw: Record<string, unknown>) => {
    const decoded = decodeManifest("architecture.yaml", raw);
    if (Result.isFailure(decoded)) throw new Error(decoded.failure.detail);
    return lowerWith(decoded.success.manifest, TYPESCRIPT, {
      substitutions: decoded.success.substitutions,
    });
  };
  const rawBase = (tree: Record<string, unknown>, defs?: Record<string, unknown>) => ({
    resolve: {
      scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }],
    },
    aliases: { "@": "pkg/src" },
    tree,
    ...(defs === undefined ? {} : { defs }),
  });
  // The allowances of one rule, minus the compiled pattern nobody wrote.
  const provenanceOf = (rules: ReadonlyArray<ImportRule>, suffix: string) =>
    (ruleNamed(rules, suffix).allowances ?? []).map(({ entry, fragment, kind, node }) => ({
      node,
      kind,
      entry,
      ...(fragment === undefined ? {} : { fragment }),
    }));

  it("stamps an entry that arrived through `use` with the fragment, and one written by hand with none", () => {
    const lowered = lowerRaw(
      rawBase(
        {
          "@/a/": { imports: { use: "shared" }, children: { "*.ts": {} } },
          "@/b/": {
            imports: { message: "own", allow: ["@/b/**"], external: ["pg"] },
            children: { "*.ts": {} },
          },
        },
        { shared: { message: "m", allow: ["@/a/**"], external: ["effect"] } },
      ),
    );
    expect(provenanceOf(lowered.imports, "a/imports")).toEqual([
      { node: "a", kind: "allow", entry: "pkg/src/a/**", fragment: "shared" },
      { node: "a", kind: "external", entry: "effect", fragment: "shared" },
    ]);
    expect(provenanceOf(lowered.imports, "b/imports")).toEqual([
      { node: "b", kind: "allow", entry: "pkg/src/b/**" },
      { node: "b", kind: "external", entry: "pg" },
    ]);
  });

  it("names the innermost fragment through nested `use`", () => {
    const lowered = lowerRaw(
      rawBase(
        { "@/a/": { use: "tier" } },
        {
          tier: { imports: { use: "shared" }, children: { "*.ts": {} } },
          shared: { message: "m", allow: ["@/a/**"] },
        },
      ),
    );
    expect(provenanceOf(lowered.imports, "a/imports")).toEqual([
      { node: "a", kind: "allow", entry: "pkg/src/a/**", fragment: "shared" },
    ]);
  });

  // `imports: { use: x, allow: […] }` takes `allow` from the reference site,
  // so those entries are the node's own; `external` still came through.
  it("attributes an override written beside `use` to the node", () => {
    const lowered = lowerRaw(
      rawBase(
        {
          "@/a/": {
            imports: { use: "shared", allow: ["@/a/**", "@/lib/**"] },
            children: { "*.ts": {} },
          },
        },
        { shared: { message: "m", allow: ["@/a/**"], external: ["effect"] } },
      ),
    );
    expect(provenanceOf(lowered.imports, "a/imports")).toEqual([
      { node: "a", kind: "allow", entry: "pkg/src/a/**" },
      { node: "a", kind: "allow", entry: "pkg/src/lib/**" },
      { node: "a", kind: "external", entry: "effect", fragment: "shared" },
    ]);
  });

  it("stamps nothing when lowered without substitutions", () => {
    const lowered = lowerManifest(
      base({ "@/a/": { imports: { message: "m", allow: ["@/a/**"] }, children: { "*.ts": {} } } }),
    );
    expect(provenanceOf(lowered.imports, "a/imports")).toEqual([
      { node: "a", kind: "allow", entry: "pkg/src/a/**" },
    ]);
  });
});
