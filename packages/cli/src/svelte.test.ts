import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadPolicyFromFile as loadPolicy } from "./config-loader.js";
import { collectFindings } from "./run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../.tmp-cli-svelte-tests");

// A component library written in Svelte: the walk has to visit the `.svelte`
// files themselves, or a story owed by one is never asked for, an import out of
// one is never refused, and a helper only a component imports reads as dead.
const MANIFEST = `export default {
  resolve: { scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }], unresolved: "error" },
  graph: {
    orphans: [{ name: "no-orphans", message: "Nothing imports this.", within: "ui/**", entry: ["ui/index.ts", "ui/*.stories.svelte"] }],
  },
  tree: {
    "ui/": {
      message: "ui/ admits components, their stories and their helpers.",
      imports: { message: "ui/ may reach only itself.", allow: ["ui/**"] },
      children: {
        "*.svelte": { message: "A component owes its story.", requires: ["{base}.stories.svelte"] },
        "*.stories.svelte": {},
        "*.ts": {},
      },
    },
  },
};
`;

const write = (file: string, source: string) => {
  const at = path.join(repoRoot, file);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, source);
};

beforeAll(() => {
  mkdirSync(repoRoot, { recursive: true });
  write("architecture.config.mjs", MANIFEST);
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  write("ui/index.ts", 'export { default as Badge } from "./badge.svelte";\n');
  write("ui/tones.ts", 'export const TONE = { muted: "text-muted" } as const;\n');
  write(
    "ui/badge.svelte",
    '<script lang="ts">\n  import { TONE } from "./tones";\n  import { secret } from "../server/secret";\n</script>\n\n<span class={TONE.muted}>{secret}</span>\n',
  );
  write("server/secret.ts", "export const secret = 1;\n");
});

afterAll(() => {
  rmSync(repoRoot, { force: true, recursive: true });
});

describe("a Svelte component", () => {
  it("is walked, its imports policed and its siblings asked for", async () => {
    const findings = collectFindings(await loadPolicy(repoRoot), ["ui"]);

    expect(findings.files).toBe(3);
    expect(
      findings.violations.map((one) => `${one.kind}:${one.ruleName}:${one.file}`).sort(),
    ).toEqual([
      "import:ui/imports:ui/badge.svelte",
      "structure:ui/*.svelte/requires:ui/badge.svelte",
    ]);
  });
});
