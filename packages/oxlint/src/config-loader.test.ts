import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Through the core's barrel on purpose: this is the surface a host sees, and a
// re-export that stops resolving is a break no internal test would notice.
import { ConfigInvalid, ReportUnavailable } from "@goodbones/core";
import * as Result from "effect/Result";
import { afterAll, describe, expect, it } from "vitest";

import { loadPolicyFromFile as loadPolicy } from "./config-loader.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// Inside the package rather than the OS temp dir: Vitest resolves the loader's
// dynamic import through its own module graph, which does not reach outside the
// project root.
const scratch = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.tmp-config-tests");
mkdirSync(scratch, { recursive: true });

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

let counter = 0;
const writeConfig = (source: string, extension = "mjs"): string => {
  counter += 1;
  const name = `config-${String(counter)}.${extension}`;
  writeFileSync(path.join(scratch, name), source);
  return path.join(scratch, name);
};

const RESOLVE = `resolve: { scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.resolve.json" } }] }`;

// A one-node manifest: a domain folder that may reach only itself.
const TREE = `tree: {
  "packages/server/src/modules/{module}/domain/": {
    message: "domain/ may only reach the contracts tier.",
    imports: {
      message: "domain/ may only reach the contracts tier.",
      allow: ["packages/server/src/modules/{module}/domain/**"],
    },
    children: { "*.root.ts": {} },
  },
}`;

describe("loadPolicy", () => {
  it("compiles a valid policy and builds a resolver for it", async () => {
    const policy = await loadPolicy(
      repoRoot,
      writeConfig(`export default { ${RESOLVE}, ${TREE} };`),
    );

    expect(policy.importRules.map((rule) => rule.name)).toEqual([
      "packages-server-src-modules-module-domain/imports",
    ]);
    expect(policy.resolver.resolve("packages/server/src/server.ts", "node:path")).toBeDefined();
    expect(policy.notices).toEqual([]);
  });

  // The shape every manifest had before scopes named their language. It loads
  // for the rest of the beta, and says once that it is on its way out.
  it("reads a scope written as { files, tsconfig } as a TypeScript scope, with a notice", async () => {
    const legacy = `resolve: { scopes: [{ files: "", tsconfig: "tsconfig.resolve.json" }], mainFields: ["main"] }`;
    const policy = await loadPolicy(
      repoRoot,
      writeConfig(`export default { ${legacy}, ${TREE} };`),
    );
    expect(policy.config.resolve.scopes).toEqual([
      {
        files: "",
        language: "typescript",
        options: { tsconfig: "tsconfig.resolve.json", mainFields: ["main"] },
      },
    ]);
    expect(policy.notices).toHaveLength(2);
    expect(policy.notices[0]).toMatch(/resolve\.mainFields/);
    expect(policy.notices[1]).toMatch(/resolve\.scopes\[0\]/);
    expect(
      Result.isSuccess(policy.resolver.resolve("packages/server/src/server.ts", "node:path")),
    ).toBe(true);
  });

  it("refuses a scope whose language no loaded pack answers to, naming both", async () => {
    const go = `resolve: { scopes: [{ files: "", language: "go" }] }`;
    await expect(
      loadPolicy(repoRoot, writeConfig(`export default { ${go}, ${TREE} };`)),
    ).rejects.toThrow(/names the language "go".*\(loaded: typescript\)/);
  });

  it("refuses a TypeScript scope whose options it does not understand", async () => {
    const typo = `resolve: { scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.resolve.json", extension: [".ts"] } }] }`;
    await expect(
      loadPolicy(repoRoot, writeConfig(`export default { ${typo}, ${TREE} };`)),
    ).rejects.toThrow(/extension/);
  });

  it("rejects a config whose shape does not decode", async () => {
    await expect(
      loadPolicy(repoRoot, writeConfig(`export default { tree: {} };`)),
    ).rejects.toBeInstanceOf(ConfigInvalid);
  });

  it("rejects a config file that cannot be imported at all", async () => {
    await expect(
      loadPolicy(repoRoot, path.join(scratch, "does-not-exist.mjs")),
    ).rejects.toBeInstanceOf(ConfigInvalid);
  });

  // The glob layer escapes most regex metacharacters, so the way to reach an
  // uncompilable pattern is a character class the engine rejects.
  it("rejects an uncompilable pattern rather than loading a rule that matches nothing", async () => {
    const broken = TREE.replace('allow: ["packages/server', 'allow: ["packages/[z-a]server');
    await expect(
      loadPolicy(repoRoot, writeConfig(`export default { ${RESOLVE}, ${broken} };`)),
    ).rejects.toThrow(/uncompilable/);
  });

  // The guard the whole package exists for: a rule that no longer reports the
  // violation it was written for must stop the lint run, not pass it.
  it("refuses to load when a rule does not report its own probe", async () => {
    // Widening the allowlist to admit everything leaves a rule that can no
    // longer report the violation it was written for.
    const drifted = TREE.replace(
      'allow: ["packages/server/src/modules/{module}/domain/**"]',
      'allow: ["packages/**"]',
    );
    await expect(
      loadPolicy(repoRoot, writeConfig(`export default { ${RESOLVE}, ${drifted} };`)),
    ).rejects.toThrow(/do not report their own probe/);
  });

  // The point of an authored probe. Both members rules below are written the
  // same way; only the snippet differs. The synthetic probe passes both. The
  // real parser reads a member out of the interface and nothing out of an
  // object literal — so the second rule is refused at load, today, rather than
  // silently enforcing nothing until someone widens the extractor.
  const membersRuleWith = (probe: string, subject = `subject: "members"`) => `tree: {
    "packages/server/src/modules/{module}/domain/": {
      children: {
        "*.repository.ts": {
          members: [
            {
              message: 'Port method "{name}" is not in the vocabulary.',
              ${subject},
              in: "*RepositoryShape",
              allow: ["findOne"],
              probe: ${probe},
            },
          ],
        },
      },
    },
  }`;

  it("loads a member rule whose source probe the parser reads and the rule reports", async () => {
    const probe = `{ source: "export interface TodosRepositoryShape { findOneById(): void }", name: "findOneById" }`;
    const policy = await loadPolicy(
      repoRoot,
      writeConfig(`export default { ${RESOLVE}, ${membersRuleWith(probe)} };`),
    );
    expect(policy.memberRules).toHaveLength(1);
  });

  it("refuses a member rule whose source probe is a shape the parser does not read", async () => {
    const probe = `{ source: "export const TodosRepositoryShape = { findOneById(): void {} };", name: "findOneById" }`;
    await expect(
      loadPolicy(
        repoRoot,
        writeConfig(`export default { ${RESOLVE}, ${membersRuleWith(probe)} };`),
      ),
    ).rejects.toThrow(/architecture facts/);
  });

  // A class body is read now, and `declares` is what keeps a rule about ports
  // from speaking to it: the same probe passes a rule about every declaration
  // and fails one about types and interfaces.
  it("judges a class-body probe by the rule's `declares`", async () => {
    const probe = `{ source: "export class TodosRepositoryShape { findOneById(): void {} }", name: "findOneById" }`;
    const every = await loadPolicy(
      repoRoot,
      writeConfig(`export default { ${RESOLVE}, ${membersRuleWith(probe)} };`),
    );
    expect(every.memberRules).toHaveLength(1);

    const typesOnly = `subject: "members", declares: ["type", "interface"]`;
    await expect(
      loadPolicy(
        repoRoot,
        writeConfig(`export default { ${RESOLVE}, ${membersRuleWith(probe, typesOnly)} };`),
      ),
    ).rejects.toThrow(/probe parsed by typescript/);
  });

  // The old spelling still loads, as the pair it always meant, and says so once.
  it('reads `subject: "type-members"` as members declared in a type or interface, with a notice', async () => {
    const probe = `{ source: "export interface TodosRepositoryShape { findOneById(): void }", name: "findOneById" }`;
    const policy = await loadPolicy(
      repoRoot,
      writeConfig(
        `export default { ${RESOLVE}, ${membersRuleWith(probe, `subject: "type-members"`)} };`,
      ),
    );
    expect(policy.memberRules[0]?.subject).toBe("members");
    expect(policy.memberRules[0]?.declares).toEqual(["type", "interface"]);
    expect(policy.notices).toEqual([expect.stringMatching(/"\*\.repository\.ts".*type-members/)]);
  });

  it("checks an export restriction's source probe through the parser too", async () => {
    // A default import, against a rule that (by default) covers named bindings only.
    const restriction = `exports: [{
      name: "no-factories",
      message: "A factory is built at a composition root.",
      module: "lib/**",
      symbols: ["makeBus"],
      probe: { source: 'import makeBus from "lib/bus";', symbol: "default" },
    }]`;
    await expect(
      loadPolicy(repoRoot, writeConfig(`export default { ${RESOLVE}, ${restriction}, tree: {} };`)),
    ).rejects.toThrow(/no-factories/);
  });

  it("refuses a restriction whose symbols can never meet its kinds", async () => {
    // A default binding is only ever named `default`, so a rule listing both a
    // symbol and the default kind could never fire on either form.
    const restriction = `exports: [{
      name: "contradiction",
      message: "…",
      module: "lib/**",
      symbols: ["makeBus"],
      kinds: ["default"],
    }]`;
    await expect(
      loadPolicy(repoRoot, writeConfig(`export default { ${RESOLVE}, ${restriction}, tree: {} };`)),
    ).rejects.toThrow(/contradiction/);
  });

  it("loads a surface rule, and refuses one whose source probe the parser reads nothing from", async () => {
    const tree = (probe: string) => `tree: {
      "packages/web/src/": {
        layout: "open",
        children: {},
        surface: [{ message: "No default exports.", kinds: ["default"], probe: ${probe} }],
      },
    }`;
    const loaded = await loadPolicy(
      repoRoot,
      writeConfig(`export default { ${RESOLVE}, ${tree('{ source: "export default 1;" }')} };`),
    );
    expect(loaded.surfaceRules).toHaveLength(1);

    await expect(
      loadPolicy(
        repoRoot,
        writeConfig(`export default { ${RESOLVE}, ${tree('{ source: "export const x = 1;" }')} };`),
      ),
    ).rejects.toThrow(/surface-0/);
  });

  it("compiles and probes graph rules, whichever adapter loads", async () => {
    const graph = (via: string) => `graph: {
      reach: [{ name: "via-ports", message: "…", from: "src/adapters/**", to: "src/infra/**", via: "${via}" }],
    }`;
    const loaded = await loadPolicy(
      repoRoot,
      writeConfig(`export default { ${RESOLVE}, ${graph("src/ports/**")}, tree: {} };`),
    );
    expect(loaded.graph.reach).toHaveLength(1);

    // A `via` that covers the target itself: nothing could ever be reached
    // without passing through it, so the rule enforces nothing.
    await expect(
      loadPolicy(
        repoRoot,
        writeConfig(`export default { ${RESOLVE}, ${graph("src/infra/**")}, tree: {} };`),
      ),
    ).rejects.toThrow(/via-ports/);
  });

  it("refuses a policy with more unrestricted tiers than its own ceiling allows", async () => {
    const tree = `tree: {
      "packages/web/src/": { layout: "open", children: {}, imports: { message: "…", unrestricted: true } },
      "packages/api/src/": { layout: "open", children: {}, imports: { message: "…", unrestricted: true } },
    }`;
    const loaded = await loadPolicy(
      repoRoot,
      writeConfig(`export default { ${RESOLVE}, limits: { unrestricted: 2 }, ${tree} };`),
    );
    expect(loaded.adoption.unrestricted).toHaveLength(2);

    await expect(
      loadPolicy(
        repoRoot,
        writeConfig(`export default { ${RESOLVE}, limits: { unrestricted: 1 }, ${tree} };`),
      ),
    ).rejects.toThrow(/adoption ceiling.*unrestricted: 2 nodes against a ceiling of 1/);
  });

  it("compiles the repo's own policy, so this suite fails if that config breaks", async () => {
    const policy = await loadPolicy(repoRoot);
    expect(policy.importRules.length).toBeGreaterThan(0);
  });
});

// The plugin reads a data manifest through the same loader as a module one,
// and adds what only a data file can give: the line a mistake is on.
// A `report` command forks the process that asks for it. Under oxlint that
// process is the linter, and once it is linting Linux can refuse the fork —
// so the plugin reads every report at load, before a file is seen, and the
// rules read the cached answer. A report that cannot be read is not a load
// failure: the campaigns rule says so once, on a file.
describe("loadPolicy reads every report at load", () => {
  const campaign = (report: string) => `campaigns: { "type-errors": {
    why: "w", how: "h", scope: ["packages/**"], staleAfter: "30d",
    objectives: { tsc: {
      holdout: "match",
      match: { report: { ${report}, format: "tsc" } },
      probes: { fires: [{ path: "packages/x.ts", report: [{ line: 1, code: "TS1", message: "m" }] }] },
    } },
  } }`;

  it("runs a command before any file is linted, once", async () => {
    const stamp = path.join(scratch, "ran-at-load");
    rmSync(stamp, { force: true });
    const command = `node -e "require('fs').appendFileSync('${stamp}', 'x')"`;
    const policy = await loadPolicy(
      repoRoot,
      writeConfig(
        `export default { ${RESOLVE}, ${campaign(`command: ${JSON.stringify(command)}`)}, tree: {} };`,
      ),
    );
    expect(readFileSync(stamp, "utf8")).toBe("x");
    // The rules ask the same source and get the cached answer, not a second run.
    policy.reports.diagnosticsOf({ command, format: "tsc" }, "packages/x.ts");
    expect(readFileSync(stamp, "utf8")).toBe("x");
  });

  it("runs a term's several commands at load, as one report", async () => {
    const stamp = path.join(scratch, "ran-several-at-load");
    rmSync(stamp, { force: true });
    const mark = (name: string) =>
      `node -e "require('fs').appendFileSync('${stamp}', '${name}'); console.log('packages/x.ts(1,1): error TS1: m')"`;
    const command = [mark("a"), mark("b")];
    const policy = await loadPolicy(
      repoRoot,
      writeConfig(
        `export default { ${RESOLVE}, ${campaign(`command: ${JSON.stringify(command)}`)}, tree: {} };`,
      ),
    );
    expect(readFileSync(stamp, "utf8").split("").sort().join("")).toBe("ab");
    // The same diagnostic from both commands is one, and nothing runs again.
    expect(policy.reports.diagnosticsOf({ command, format: "tsc" }, "packages/x.ts")).toHaveLength(
      1,
    );
    expect(readFileSync(stamp, "utf8")).toHaveLength(2);
  });

  it("still loads when the report cannot be read; the rule reports that", async () => {
    const policy = await loadPolicy(
      repoRoot,
      writeConfig(
        `export default { ${RESOLVE}, ${campaign(`file: "no-such-report.txt"`)}, tree: {} };`,
      ),
    );
    expect(() =>
      policy.reports.diagnosticsOf({ file: "no-such-report.txt", format: "tsc" }, "packages/x.ts"),
    ).toThrow(ReportUnavailable);
  });
});

describe("loadPolicy from a YAML manifest", () => {
  const YAML = `resolve:
  scopes:
    - files: ""
      language: typescript
      options: { tsconfig: tsconfig.resolve.json }
defs:
  domain-only:
    message: "domain/ may only reach the contracts tier."
    allow: ["packages/server/src/modules/{module}/domain/**"]
tree:
  "packages/server/src/modules/{module}/domain/":
    message: "domain/ may only reach the contracts tier."
    imports: { use: domain-only }
    children: { "*.root.ts": {} }
`;

  it("compiles a valid YAML policy, defs and use included", async () => {
    const policy = await loadPolicy(repoRoot, writeConfig(YAML, "yaml"));
    expect(policy.importRules.map((rule) => rule.name)).toEqual([
      "packages-server-src-modules-module-domain/imports",
    ]);
  });

  it("names the file, line and column of a shape error, and the use it came through", async () => {
    await expect(
      loadPolicy(repoRoot, writeConfig(YAML.replace("allow:", "alow:"), "yaml")),
    ).rejects.toThrow(
      /config-\d+\.yaml:9:5 {2}defs\["domain-only"\]\.alow: Unexpected key.*via `use: "domain-only"` at config-\d+\.yaml:13:5/,
    );
  });

  it("reads JSON through the same path", async () => {
    const json = JSON.stringify({
      resolve: {
        scopes: [
          { files: "", language: "typescript", options: { tsconfig: "tsconfig.resolve.json" } },
        ],
      },
      tree: { "packages/web/src/": { layout: "open", children: {} } },
    });
    const policy = await loadPolicy(repoRoot, writeConfig(json, "json"));
    expect(policy.structure.folders.length).toBeGreaterThan(0);
  });

  it("discovers the manifest by name when none is given, and says which names it looked for", async () => {
    const empty = path.join(scratch, "empty");
    mkdirSync(empty, { recursive: true });
    await expect(loadPolicy(empty)).rejects.toThrow(
      /no architecture manifest found.*architecture\.yaml, architecture\.yml, architecture\.json, architecture\.config\.mjs/,
    );
  });
});

describe("uncompilable patterns in the other three families", () => {
  const BROKEN = "[z-a]";

  it("refuses an export restriction whose module pattern cannot compile", async () => {
    const exports = `exports: [{ name: "x", message: "x", module: "**/${BROKEN}/**", symbols: ["y"] }]`;
    await expect(
      loadPolicy(repoRoot, writeConfig(`export default { ${RESOLVE}, ${exports}, ${TREE} };`)),
    ).rejects.toThrow(/uncompilable/);
  });

  it("refuses a member rule whose pattern cannot compile", async () => {
    const tree = TREE.replace(
      'children: { "*.root.ts": {} },',
      `children: { "*.root.ts": { members: [{ message: "x", subject: "calls", match: "${BROKEN}" }] } },`,
    );
    await expect(
      loadPolicy(repoRoot, writeConfig(`export default { ${RESOLVE}, ${tree} };`)),
    ).rejects.toThrow(/uncompilable/);
  });

  it("refuses a structure rule whose folder pattern cannot compile", async () => {
    const tree = TREE.replace('domain/": {', `domain/${BROKEN}/": {`);
    await expect(
      loadPolicy(repoRoot, writeConfig(`export default { ${RESOLVE}, ${tree} };`)),
    ).rejects.toThrow(/uncompilable/);
  });

  // A config module that exports the manifest directly rather than as a
  // default is the CommonJS-ish shape a `.cjs` policy would produce.
  it("accepts a manifest that is the module itself rather than its default export", async () => {
    const at =
      writeConfig(`export const resolve = { scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.resolve.json" } }] };
export const tree = { "packages/server/src/modules/{module}/domain/": { message: "m", imports: { message: "m", allow: ["packages/server/src/modules/{module}/domain/**"] }, children: { "*.root.ts": {} } } };`);
    const policy = await loadPolicy(repoRoot, at);
    expect(policy.importRules.length).toBeGreaterThan(0);
  });
});
