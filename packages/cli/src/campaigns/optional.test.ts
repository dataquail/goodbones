import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// `@goodbones/campaigns` and `@goodbones/ast-grep` are optional peers, so no
// module the bin loads up front may import either at run time: one static
// import and a user without the package cannot run `check`. A type-only
// import compiles away and is fine anywhere under `campaigns/`. The policy's
// import rules cannot tell a dynamic import from a static one, nor a type
// from a value, so this is the check that can.

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sources = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(at);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [at] : [];
  });

// Every static `import … from` / `export … from` naming the specifier, with
// the type-only ones left out. A dynamic `import("…")` is not matched.
const valueImportsOf = (text: string, specifier: string): ReadonlyArray<string> =>
  [...text.matchAll(/^(import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)]
    .filter((match) => match[3] === specifier && match[2] === undefined)
    .map((match) => match[0]);

const offenders = (specifier: string, allowed: ReadonlyArray<string>): ReadonlyArray<string> =>
  sources(src)
    .map((file) => path.relative(src, file).replaceAll(path.sep, "/"))
    .filter((file) => !allowed.includes(file))
    .filter(
      (file) => valueImportsOf(readFileSync(path.join(src, file), "utf8"), specifier).length > 0,
    )
    .sort();

describe("the optional peers", () => {
  it("loads @goodbones/campaigns only from the glue the composition root imports lazily", () => {
    expect(offenders("@goodbones/campaigns", ["campaigns/live.ts", "campaigns/verbs.ts"])).toEqual(
      [],
    );
  });

  it("reaches the glue that loads it only through a dynamic import", () => {
    expect(offenders("./campaigns/live.js", [])).toEqual([]);
    expect(offenders("./live.js", [])).toEqual([]);
    expect(offenders("./verbs.js", ["campaigns/live.ts"])).toEqual([]);
  });

  it("never imports @goodbones/ast-grep statically", () => {
    expect(offenders("@goodbones/ast-grep", [])).toEqual([]);
  });

  // The test above is only as good as its pattern: it must see the imports
  // it exists to catch.
  it("sees a static import, and passes over a type-only or dynamic one", () => {
    const text = [
      'import { a } from "@goodbones/campaigns";',
      'import type { B } from "@goodbones/campaigns";',
      'export type { C } from "@goodbones/campaigns";',
      'const d = await import("@goodbones/campaigns");',
      'import {\n  e,\n  f,\n} from "@goodbones/campaigns";',
    ].join("\n");
    expect(valueImportsOf(text, "@goodbones/campaigns")).toHaveLength(2);
  });
});
