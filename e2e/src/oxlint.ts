import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Repo } from "./repo.js";

// oxlint itself, loading the built plugin over a fixture — the other host, run
// the way a user runs it. This is the language-neutral parity check: what
// oxlint reported for the tree `check --json` reported on.

const here = path.dirname(fileURLToPath(import.meta.url));

export const PLUGIN = path.resolve(here, "../../packages/oxlint/build/esm/plugin.js");
const OXLINT = path.resolve(here, "../node_modules/.bin/oxlint");

export const RULES = ["imports", "exports", "members", "structure", "surface"] as const;

export type Diagnostic = {
  readonly file: string;
  // `architecture/imports`, and so on.
  readonly rule: string;
  readonly message: string;
  readonly severity: string;
};

export type OxlintResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  // Whether oxlint got as far as linting: false when the plugin failed to load.
  readonly loaded: boolean;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
};

export type OxlintOptions = {
  // The plugin specifier the config names; defaults to this checkout's build
  // by absolute path.
  readonly plugin?: string;
  readonly env?: Readonly<Record<string, string>>;
};

type RawDiagnostic = {
  readonly message: string;
  readonly code: string;
  readonly severity: string;
  readonly filename: string;
};

// oxlint spells a rule as `plugin(rule)` in its JSON output.
const ruleOf = (code: string): string => code.replace(/^([^(]+)\((.+)\)$/, "$1/$2");

export const oxlint = (
  repo: Repo,
  roots: ReadonlyArray<string>,
  options: OxlintOptions = {},
): OxlintResult => {
  repo.write(
    ".oxlintrc.json",
    `${JSON.stringify(
      {
        jsPlugins: [{ name: "architecture", specifier: options.plugin ?? PLUGIN }],
        categories: { correctness: "off" },
        rules: Object.fromEntries(RULES.map((rule) => [`architecture/${rule}`, "error"])),
      },
      null,
      2,
    )}\n`,
  );
  const run = spawnSync(OXLINT, ["--format", "json", "-c", ".oxlintrc.json", ...roots], {
    cwd: repo.root,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (run.error !== undefined) throw run.error;

  let diagnostics: ReadonlyArray<Diagnostic> = [];
  let loaded = false;
  try {
    const parsed = JSON.parse(run.stdout) as { readonly diagnostics: ReadonlyArray<RawDiagnostic> };
    loaded = true;
    diagnostics = parsed.diagnostics.map((one) => ({
      file: one.filename.replaceAll(path.sep, "/"),
      rule: ruleOf(one.code),
      message: one.message,
      severity: one.severity,
    }));
  } catch {
    // Not JSON: oxlint failed before linting, and said why in prose.
  }
  return { code: run.status ?? -1, stdout: run.stdout, stderr: run.stderr, loaded, diagnostics };
};
