import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { check } from "../cli.js";
import { oxlint } from "../oxlint.js";
import { createRepo, type Repo } from "../repo.js";

// A Svelte component under both hosts. oxlint lints a `.svelte` file's script
// blocks and hands them to the plugin; the CLI walks the same file and reads
// the same blocks. Both have to ask for the story it owes and refuse the import
// that leaves its tier, and the CLI alone sees that the helper it imports is
// not dead.

const RULE_OF: Readonly<Record<string, string>> = {
  import: "architecture/imports",
  structure: "architecture/structure",
};

let repo: Repo;

beforeAll(() => {
  repo = createRepo();
  repo.write("ui/index.ts", 'export { default as Badge } from "./badge.svelte";\n');
  repo.write("ui/tones.ts", 'export const TONE = { muted: "text-muted" } as const;\n');
  repo.write(
    "ui/badge.svelte",
    [
      '<script lang="ts">',
      '  import { TONE } from "./tones";',
      '  import { secret } from "../server/secret";',
      "</script>",
      "",
      "<span class={TONE.muted}>{secret}</span>",
      "",
    ].join("\n"),
  );
  repo.write("server/secret.ts", "export const secret = 1;\n");
  repo.writeManifest({
    resolve: { scopes: [repo.profile.scope], unresolved: "error" },
    graph: {
      orphans: [
        {
          name: "no-orphans",
          message: "Nothing imports this.",
          within: "ui/**",
          entry: ["ui/index.ts"],
        },
      ],
    },
    tree: {
      "ui/": {
        message: "ui/ admits components, their stories and their helpers.",
        imports: { message: "ui/ may reach only itself.", allow: ["ui/**"] },
        children: {
          "*.svelte": {
            message: "A component owes its story.",
            requires: ["{base}.stories.svelte"],
          },
          "*.stories.svelte": {},
          "*.ts": {},
        },
      },
    },
  });
});

afterAll(() => {
  repo.dispose();
});

describe("a Svelte component", () => {
  it("is held to the same per-file findings by check and by oxlint", () => {
    const { json } = check(repo, ["ui"]);
    const linted = oxlint(repo, ["ui"]);
    expect(linted.loaded, linted.stdout + linted.stderr).toBe(true);

    const expected = json.violations
      .map((one) => `${RULE_OF[one.kind] ?? one.kind} ${one.file} [${one.ruleName}]`)
      .sort();

    const reported = linted.diagnostics
      .map((one) => `${one.rule} ${one.file} ${one.message.split("]")[0] ?? ""}]`)
      .sort();

    expect(expected).toEqual([
      "architecture/imports ui/badge.svelte [ui/imports]",
      "architecture/structure ui/badge.svelte [ui/*.svelte/requires]",
    ]);
    expect(reported).toEqual(expected);
  });
});
