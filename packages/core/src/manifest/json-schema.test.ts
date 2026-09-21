import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { snapshotJsonSchema } from "../domain/snapshot.js";
import {
  MANIFEST_NODE_SCHEMA_ID,
  MANIFEST_SCHEMA_ID,
  manifestJsonSchema,
  manifestNodeJsonSchema,
} from "./json-schema.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const committed = path.join(root, "packages/core/schema/architecture.schema.json");
const committedNode = path.join(root, "packages/core/schema/architecture-node.schema.json");
const committedSnapshot = path.join(root, "packages/core/schema/conformance.schema.json");

const validator = () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(manifestJsonSchema());
};

const nodeValidator = () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(manifestNodeJsonSchema());
};

// The per-package files this repository's own manifest includes.
const includedNodes = readdirSync(path.join(root, "packages"))
  .map((name) => path.join(root, "packages", name, "architecture.yaml"))
  .filter((file) => existsSync(file));

describe("the manifest JSON Schema", () => {
  // The committed file is what the docs site publishes and what an editor
  // fetches. It is generated, and this is what says when it is stale.
  it("is what packages/core/schema/architecture.schema.json holds", () => {
    const expected = `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`;
    expect(readFileSync(committed, "utf8")).toBe(expected);
  });

  it("names itself at the URL the docs site publishes", () => {
    expect(manifestJsonSchema().$id).toBe(MANIFEST_SCHEMA_ID);
    expect(MANIFEST_SCHEMA_ID).toMatch(/^https:\/\/dataquail\.github\.io\/goodbones\/schema\//);
  });

  it("validates this repository's own manifest, defs, use and include included", () => {
    const validate = validator();
    const manifest: unknown = parse(readFileSync(path.join(root, "architecture.yaml"), "utf8"));
    expect(validate(manifest), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("admits an include wherever an object or a list may stand", () => {
    const validate = validator();
    expect(
      validate({
        defs: { include: "defs.yaml" },
        resolve: { scopes: [] },
        exports: { include: "exports.yaml" },
        graph: { cycles: [{ include: "cycles.yaml" }] },
        tree: {
          "src/": { include: "src.yaml" },
          "lib/": { imports: { include: "floor.yaml" }, members: [{ include: "rule.yaml" }] },
        },
      }),
      JSON.stringify(validate.errors, null, 2),
    ).toBe(true);
  });

  it("rejects a key beside include", () => {
    const validate = validator();
    expect(
      validate({
        resolve: { scopes: [] },
        tree: { "src/": { include: "src.yaml", layout: "open" } },
      }),
    ).toBe(false);
  });

  it("rejects a misspelled key", () => {
    const validate = validator();
    expect(
      validate({
        resolve: { scopes: [] },
        tree: {
          "src/": { children: {}, members: [{ message: "m", subject: "calls", matchNott: "x" }] },
        },
      }),
    ).toBe(false);
    expect(JSON.stringify(validate.errors)).toContain("matchNott");
  });

  it("rejects a value outside its enum", () => {
    const validate = validator();
    expect(validate({ resolve: { scopes: [] }, tree: { "src/": { layout: "closed" } } })).toBe(
      false,
    );
  });

  it("admits a use with overrides wherever an object may stand, and a $schema key", () => {
    const validate = validator();
    expect(
      validate({
        $schema: MANIFEST_SCHEMA_ID,
        defs: { floor: { allow: ["node:**"] }, rule: { message: "m", subject: "calls" } },
        resolve: { scopes: [] },
        graph: { cycles: [{ use: "rule" }] },
        tree: {
          "src/": { use: "node" },
          "lib/": {
            imports: { use: "floor", message: "m" },
            members: [{ use: "rule", except: ["x"] }],
          },
        },
      }),
      JSON.stringify(validate.errors, null, 2),
    ).toBe(true);
  });

  it("names the recursive node and the recursive detector", () => {
    const schema = manifestJsonSchema() as { $defs: Record<string, unknown> };
    expect(Object.keys(schema.$defs).sort()).toEqual([
      "Detector",
      "Include",
      "ManifestNode",
      "Use",
    ]);
  });

  // The campaigns from the family's docs page — one per shape the design
  // names — and a misspelled term key: the detector is a union of one-key
  // objects, so the wrong key is refused rather than read as a term that
  // matches nothing.
  const campaigns = {
    "react-class-components": {
      title: "Class components to hooks",
      why: "Class lifecycle methods block concurrent features.",
      how: "Convert to a function component.",
      owner: "@dataquail/web-platform",
      scope: ["apps/web/src/**/*.tsx"],
      objectives: {
        "class-shape": {
          holdout: "declaration",
          match: {
            syntax: {
              pattern: "class $NAME extends $BASE { $$$ }",
              where: {
                BASE: {
                  binding: { resolves: { external: "react" }, member: ["Component", "PureComponent"] },
                },
              },
            },
          },
          probes: {
            fires: [
              {
                path: "apps/web/src/a.tsx",
                source: "import { Component } from 'react'; export class Foo extends Component {}",
                edges: { react: { external: "react" } },
              },
            ],
            ignores: [{ path: "apps/web/src/b.tsx", source: "class Foo extends Base {}" }],
          },
        },
      },
      staleAfter: "30d",
      onComplete: "keep",
    },
    "rsc-boundaries": {
      why: "Server components render on the server.",
      how: "Add the directive or move the hook.",
      scope: ["app/**/*.tsx"],
      objectives: {
        "client-boundary": {
          holdout: "file",
          match: {
            all: [
              { not: { content: { regex: "^[\"']use client[\"']" } } },
              {
                any: [
                  { syntax: { pattern: "$HOOK($$$)", where: { HOOK: { regex: "^use[A-Z]" } } } },
                  { imports: { resolves: { external: "framer-motion" } } },
                  { fn: "./campaigns/rsc.mjs#needsClientBoundary" },
                ],
              },
            ],
          },
          probes: { fires: [{ path: "app/x.tsx", source: "export default () => { useState(); }" }] },
        },
      },
      staleAfter: "30d",
    },
    "billing-ddd": {
      scope: "src/**",
      legacy: "src/services/**",
      perimeter: { marker: "**/context.ts", probes: { fires: "src/billing/context.ts" } },
      onTouch: "ratchet",
      phases: [
        { id: "domain", intent: "a domain module with unit tests", objectives: ["no-io-in-domain"] },
        { id: "repository", objectives: ["has-migration"], concessions: [{ reason: "widened", at: "2026-09-20" }] },
        { id: "dual-write", objectives: ["has-flag"] },
        { id: "backfilled", intent: "rows copied", attested: true },
        { id: "cutover", objectives: ["no-flag"], onTouch: "paydown" },
        { id: "aggregates", intent: "undecided until two contexts have reached cutover" },
      ],
      objectives: {
        "no-io-in-domain": {
          holdout: "declaration",
          match: { all: [{ path: { file: "**/domain/**" } }, { members: { subject: "calls", name: "readFileSync" } }] },
          probes: { fires: [{ path: "src/billing/domain/a.ts", source: "readFileSync()" }] },
        },
        "has-migration": { holdout: "sector", sector: { has: { path: { file: "**/migrations/*.ts" } } } },
        "has-flag": {
          holdout: "sector",
          until: "cutover",
          sector: { has: { content: { regex: "flags.billingDualWrite" } } },
        },
        "no-flag": {
          holdout: "match",
          match: { content: { regex: "flags.billingDualWrite" } },
          probes: { fires: [{ path: "src/billing/a.ts", source: "flags.billingDualWrite" }] },
        },
      },
    },
    "hapi-strangler": {
      scope: ["hapi/src/**", "nest/src/**"],
      perimeter: { marker: "**/port.ts" },
      phases: [
        { id: "onion", objectives: ["one-root"] },
        {
          id: "cqrs",
          objectives: ["one-host"],
          endState: {
            "~/": {
              layout: "open",
              children: {
                "domain/": { layout: "open", children: {}, imports: { allow: ["~/domain/"] } },
                "adapters/": { layout: "open", children: {}, imports: { allow: ["~/ports/", { sector: "*", via: "~/ports/" }] } },
              },
            },
          },
        },
      ],
      objectives: {
        "one-root": { holdout: "sector", sector: { oneRoot: true } },
        "one-host": { holdout: "sector", sector: { oneHost: "nest/**" } },
      },
    },
    "js-to-ts": {
      scope: { path: "src/**", extensions: [".js", ".jsx"] },
      perimeter: "file",
      phases: [{ id: "typescript", objectives: ["is-ts"] }, { id: "strict", objectives: ["strict-clean"] }],
      objectives: {
        "is-ts": {
          holdout: "file",
          match: { path: { file: "**/*.{js,jsx}" } },
          probes: { fires: [{ path: "src/a.js" }], ignores: [{ path: "src/a.ts" }] },
        },
        "strict-clean": {
          holdout: "match",
          match: { report: { command: "tsc --noEmit --pretty false", format: "tsc", codesNot: ["TS6133"] } },
          probes: {
            fires: [{ path: "src/a.ts", report: [{ line: 1, code: "TS2551", message: "m" }] }],
          },
        },
      },
    },
    "pages-to-app": {
      scope: "src/**",
      perimeter: {
        match: { exports: { kinds: ["default"] } },
        holdout: "declaration",
        probes: { fires: [{ path: "src/pages/a.tsx", source: "export default function A() {}" }] },
      },
      objectives: {
        "old-shape": {
          holdout: "declaration",
          match: { exports: { kinds: ["default"], declares: ["class"] } },
          probes: { fires: [{ path: "src/pages/a.tsx", source: "export default class A {}" }] },
        },
      },
    },
    "by-project": {
      perimeter: "nx",
      objectives: {
        "no-any": {
          holdout: "match",
          match: { content: { regex: ": any" } },
          probes: { fires: [{ path: "libs/a.ts", source: "let x: any" }] },
        },
      },
    },
  };

  it("validates the campaign examples, and a ledger path", () => {
    const validate = validator();
    const manifest = {
      resolve: { scopes: [{ files: "", language: "typescript" }] },
      ledger: ".architecture-campaigns",
      campaigns,
      tree: {},
    };
    expect(validate(manifest), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("rejects a misspelled term key, a duration in the wrong shape, and the family's first shape", () => {
    const validate = validator();
    const base = { resolve: { scopes: [{ files: "", language: "typescript" }] }, tree: {} };
    const first = campaigns["react-class-components"];
    const withObjective = (objective: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      ...base,
      campaigns: {
        one: { ...first, ...extra, objectives: { "class-shape": { ...first.objectives["class-shape"], ...objective } } },
      },
    });
    expect(validate(withObjective({ match: { syntaxx: { pattern: "x" } } }))).toBe(false);
    expect(validate(withObjective({ match: { content: { regexp: "x" } } }))).toBe(false);
    expect(validate(withObjective({}, { staleAfter: "30 days" }))).toBe(false);
    expect(validate(withObjective({ match: { report: { command: "x", format: "junit" } } }))).toBe(false);
    expect(validate(withObjective({ holdout: "line" }))).toBe(false);
    expect(validate({ ...base, campaigns: [{ id: "x" }] })).toBe(false);
    expect(validate({ ...base, campaigns: { "Not Kebab": first } })).toBe(false);
    expect(validate({ ...base, campaigns: { one: { ...first, perimeter: "folder" } } })).toBe(false);
    expect(validate({ ...base, campaigns: { one: { ...first, onTouch: "nag" } } })).toBe(false);
  });
});

// The snapshot's schema is generated in the domain, which reads no file — so
// the check that its committed copy is current lives here, beside the others.
describe("the conformance snapshot JSON Schema", () => {
  it("is what packages/core/schema/conformance.schema.json holds", () => {
    const expected = `${JSON.stringify(snapshotJsonSchema(), null, 2)}\n`;
    expect(readFileSync(committedSnapshot, "utf8")).toBe(expected);
  });
});

describe("the node JSON Schema", () => {
  it("is what packages/core/schema/architecture-node.schema.json holds", () => {
    const expected = `${JSON.stringify(manifestNodeJsonSchema(), null, 2)}\n`;
    expect(readFileSync(committedNode, "utf8")).toBe(expected);
  });

  it("names itself beside the manifest's", () => {
    expect(manifestNodeJsonSchema().$id).toBe(MANIFEST_NODE_SCHEMA_ID);
    expect(MANIFEST_NODE_SCHEMA_ID).toMatch(
      /^https:\/\/dataquail\.github\.io\/goodbones\/schema\//,
    );
  });

  it("validates each file this repository's manifest includes", () => {
    expect(includedNodes.length).toBeGreaterThan(0);
    const validate = nodeValidator();
    for (const file of includedNodes) {
      const node: unknown = parse(readFileSync(file, "utf8"));
      expect(validate(node), `${file}\n${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
    }
  });

  it("admits the defs and $schema keys a file of its own carries, and a use below", () => {
    const validate = nodeValidator();
    expect(
      validate({
        $schema: MANIFEST_NODE_SCHEMA_ID,
        defs: { rule: { message: "m", subject: "calls" } },
        layout: "open",
        children: { "domain/": { children: {}, members: [{ use: "rule" }] } },
      }),
      JSON.stringify(validate.errors, null, 2),
    ).toBe(true);
  });

  it("rejects a misspelled key, and a whole manifest", () => {
    const validate = nodeValidator();
    expect(validate({ children: {}, layuot: "open" })).toBe(false);
    expect(validate({ resolve: { scopes: [] }, tree: {} })).toBe(false);
  });
});
