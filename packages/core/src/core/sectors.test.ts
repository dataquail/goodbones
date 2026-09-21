import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { CampaignRule } from "../domain/architecture-config.js";
import { globToRegExp } from "../manifest/glob.js";
import { compileCampaignRule, type CompiledCampaign } from "./campaigns.js";
import {
  discoverSectors,
  entryOf,
  fixedPrefixOf,
  IMPLICIT_SECTOR,
  LEGACY_SECTOR,
  parseSectorMarker,
  rootOf,
  type SectorDiscovery,
  withoutExtension,
} from "./sectors.js";

const campaign = (overrides: Partial<CampaignRule> = {}): CompiledCampaign => {
  const compiled = compileCampaignRule({
    name: "campaign/c",
    id: "c",
    scope: "^src/",
    extensions: [],
    phases: [],
    objectives: [],
    onComplete: "keep",
    ...overrides,
  });
  if (Result.isFailure(compiled)) throw compiled.failure;
  return compiled.success;
};

const discovery = (
  files: ReadonlyArray<string>,
  overrides: Partial<SectorDiscovery> = {},
): SectorDiscovery => ({
  files,
  readText: () => null,
  globToRegExp,
  ...overrides,
});

describe("the marker", () => {
  it("reads the exported sector object as a person writes it, and executes nothing", () => {
    expect(
      parseSectorMarker(
        "import x from 'y';\nexport const sector = { name: 'billing', owns: [\"src/controllers/billing*\", 'src/services/billing/**',], } as const;\n",
      ),
    ).toEqual({ name: "billing", owns: ["src/controllers/billing*", "src/services/billing/**"] });
    expect(parseSectorMarker("export const sector: Sector = { name: \"a\" };")).toEqual({
      name: "a",
    });
    expect(parseSectorMarker("export const port = {};")).toBeNull();
    expect(() => parseSectorMarker("export const sector = { name: fn() };")).toThrow(
      "not a plain literal",
    );
    expect(() => parseSectorMarker("export const sector = { name: 1 };")).toThrow("`name`");
  });

  it("names the sector, owns its folder by default and the globs it lists otherwise", () => {
    const rule = campaign({ perimeter: { kind: "marker", marker: "^.*/context\\.ts$" } });
    const files = [
      "src/billing/context.ts",
      "src/billing/domain/invoice.ts",
      "src/controllers/billingController.ts",
      "src/orders/context.ts",
      "src/orders/order.ts",
      "src/services/legacy.ts",
    ];
    const index = discoverSectors(
      rule,
      discovery(files, {
        readText: (file) =>
          file === "src/billing/context.ts"
            ? 'export const sector = { name: "billing", owns: ["src/controllers/billing*"] };'
            : "",
      }),
    );
    expect([...index.sectors.keys()]).toEqual(["billing", "orders"]);
    const billing = index.sectors.get("billing");
    expect(billing?.roots).toEqual(["src/billing", "src/controllers"]);
    expect(billing?.files).toEqual(["src/billing/context.ts", "src/controllers/billingController.ts"]);
    expect(billing?.marker).toBe("src/billing/context.ts");
    expect(index.sectors.get("orders")?.files).toEqual(["src/orders/context.ts", "src/orders/order.ts"]);
    // The domain file is under the marker's folder but the marker lists
    // globs, so it is unclaimed: legacy.
    expect(index.legacy).toEqual(["src/billing/domain/invoice.ts", "src/services/legacy.ts"]);
    expect(index.sectorOf("src/services/legacy.ts")).toBe(LEGACY_SECTOR);
    expect(index.sectorOf("src/orders/order.ts")).toBe("orders");
    expect(index.drift).toEqual([]);
  });

  it("refuses a marker that does not read, naming it", () => {
    const rule = campaign({ perimeter: { kind: "marker", marker: "^.*/context\\.ts$" } });
    expect(() =>
      discoverSectors(
        rule,
        discovery(["src/a/context.ts"], { readText: () => "export const sector = { name: f() }" }),
      ),
    ).toThrow("src/a/context.ts");
  });
});

describe("the other perimeters", () => {
  it("file: one sector per file, named without its extension", () => {
    const rule = campaign({ perimeter: { kind: "file" } });
    const index = discoverSectors(rule, discovery(["src/a.js", "src/b/c.ts"]));
    expect([...index.sectors.keys()]).toEqual(["src/a", "src/b/c"]);
    expect(index.sectors.get("src/a")?.roots).toEqual(["src"]);
    expect(withoutExtension("src/a.test.ts")).toBe("src/a.test");
    expect(withoutExtension("src/.env")).toBe("src/.env");
  });

  it("glob: one sector per match, named by the match", () => {
    const rule = campaign({ perimeter: { kind: "glob", glob: "^src/components/[^/]*/" } });
    const index = discoverSectors(
      rule,
      discovery(["src/components/Foo/Foo.tsx", "src/components/Foo/useFoo.ts", "src/components/Bar/Bar.tsx", "src/lib.ts"]),
    );
    expect([...index.sectors.keys()]).toEqual(["src/components/Bar", "src/components/Foo"]);
    expect(index.sectors.get("src/components/Foo")?.files).toEqual([
      "src/components/Foo/Foo.tsx",
      "src/components/Foo/useFoo.ts",
    ]);
    expect(index.legacy).toEqual(["src/lib.ts"]);
  });

  it("match: one sector per matched declaration, and a hit lands in the one it is anchored in", () => {
    const rule = campaign({
      perimeter: {
        kind: "match",
        match: { exports: {} },
        unit: "declaration",
        probes: { fires: [], ignores: [] },
      },
    });
    const index = discoverSectors(
      rule,
      discovery(["src/pages.tsx", "src/util.ts"], {
        perimeterMatches: (file) => (file === "src/pages.tsx" ? ["Home", "About"] : []),
      }),
    );
    expect([...index.sectors.keys()].sort()).toEqual(["src/pages.tsx#About", "src/pages.tsx#Home"]);
    expect(index.sectorOfHit("src/pages.tsx", "Home")).toBe("src/pages.tsx#Home");
    expect(index.sectorOfHit("src/pages.tsx", "Home#abcd1234")).toBe("src/pages.tsx#Home");
    // A file-level hit in a file holding two sectors is nobody's: legacy.
    expect(index.sectorOfHit("src/pages.tsx", null)).toBe(LEGACY_SECTOR);
    expect(index.sectorOfHit("src/util.ts", null)).toBe(LEGACY_SECTOR);
  });

  it("nx: the workspace's projects", () => {
    const rule = campaign({ perimeter: { kind: "nx" } });
    const index = discoverSectors(
      rule,
      discovery(["src/apps/web/main.ts", "src/libs/ui/index.ts", "src/stray.ts"], {
        projects: [
          { name: "web", root: "src/apps/web" },
          { name: "ui", root: "src/libs/ui" },
          { name: "empty", root: "src/libs/empty" },
        ],
      }),
    );
    expect([...index.sectors.keys()]).toEqual(["web", "ui"]);
    expect(index.legacy).toEqual(["src/stray.ts"]);
  });

  it("none: the scope is one implicit sector rooted at the repository", () => {
    const index = discoverSectors(campaign(), discovery(["src/a.ts", "src/b.ts"]));
    expect([...index.sectors.keys()]).toEqual([IMPLICIT_SECTOR]);
    expect(index.legacy).toEqual([]);
    expect(index.sectorOf("src/a.ts")).toBe(IMPLICIT_SECTOR);
  });

  it("legacy narrows the remainder: an unclaimed file outside it is in no sector", () => {
    const rule = campaign({
      perimeter: { kind: "glob", glob: "^src/ctx/[^/]*/" },
      legacy: "^src/services/",
    });
    const index = discoverSectors(
      rule,
      discovery(["src/ctx/a/x.ts", "src/services/y.ts", "src/other/z.ts"]),
    );
    expect(index.legacy).toEqual(["src/services/y.ts"]);
    expect(index.sectorOf("src/other/z.ts")).toBeNull();
  });

  it("reports a file two sectors claim", () => {
    const rule = campaign({ perimeter: { kind: "marker", marker: "^.*/context\\.ts$" } });
    const index = discoverSectors(
      rule,
      discovery(["src/a/context.ts", "src/a/b/context.ts", "src/a/b/x.ts"]),
    );
    expect(index.drift).toEqual([
      { file: "src/a/b/context.ts", sectors: ["a", "b"] },
      { file: "src/a/b/x.ts", sectors: ["a", "b"] },
    ]);
  });
});

describe("entries relative to the root", () => {
  it("writes a holdout from the sector's root, so a lift moves nothing", () => {
    const sector = {
      name: "billing",
      roots: ["hapi/src/billing", "nest/src/billing"],
      files: [],
      marker: null,
      declaration: null,
    };
    const hit = { kind: "campaign" as const, ruleName: "r", message: "m", file: "", subject: null };
    expect(rootOf(sector, "hapi/src/billing/a.ts")).toBe("hapi/src/billing");
    expect(entryOf({ ...hit, file: "hapi/src/billing/a.ts", subject: "f#1" }, "hapi/src/billing")).toBe(
      "a.ts#f#1",
    );
    expect(entryOf({ ...hit, file: "nest/src/billing/a.ts", subject: "f#1" }, "nest/src/billing")).toBe(
      "a.ts#f#1",
    );
    expect(entryOf({ ...hit, file: "src/a.ts" }, "")).toBe("src/a.ts");
    expect(fixedPrefixOf("src/controllers/billing*")).toBe("src/controllers");
    expect(fixedPrefixOf("src/**")).toBe("src");
    expect(fixedPrefixOf("*.ts")).toBe("");
  });
});
