import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Repo } from "./repo.js";

// The bin a user installs, run as a subprocess from the fixture's root. This
// module never imports `@goodbones/*`: the point is the emitted output, its
// exit code, its stdout and its stderr.

const here = path.dirname(fileURLToPath(import.meta.url));

export const BIN = path.resolve(here, "../../packages/cli/build/esm/main.js");

export type CliResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CliOptions = {
  readonly env?: Readonly<Record<string, string>>;
  // The bin to run; defaults to this checkout's build.
  readonly bin?: string;
};

export const cli = (
  repo: Repo,
  argv: ReadonlyArray<string>,
  options: CliOptions = {},
): CliResult => {
  const bin = options.bin ?? BIN;
  const run = spawnSync(process.execPath, [bin, ...argv], {
    cwd: repo.root,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (run.error !== undefined) throw run.error;
  return { code: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
};

// The shape `check --json` prints. Declared here rather than imported, since
// this is the contract under test.
export type ViolationKind = "import" | "export" | "structure" | "member" | "surface" | "graph";

export type CheckJson = {
  readonly version: 1;
  readonly files: number;
  readonly roots: ReadonlyArray<string>;
  readonly ok: boolean;
  readonly manifest: { readonly path: string; readonly sha256: string };
  readonly violations: ReadonlyArray<{
    readonly fingerprint: string;
    readonly kind: ViolationKind;
    readonly ruleName: string;
    readonly file: string;
    readonly subject: string | null;
    readonly message: string;
    readonly baselined: boolean;
  }>;
  readonly unresolved: ReadonlyArray<{
    readonly file: string;
    readonly specifier: string;
    readonly detail: string;
  }>;
  readonly stale: ReadonlyArray<string>;
  readonly coverage: Readonly<
    Record<
      "imports" | "structure" | "members" | "surface" | "graph",
      { readonly covered: number; readonly total: number; readonly floor?: number }
    >
  >;
  readonly adoption: {
    readonly unrestricted: ReadonlyArray<string>;
    readonly partial: ReadonlyArray<string>;
  };
};

export type CheckResult = CliResult & { readonly json: CheckJson };

// `check --json` over these roots. stdout must be exactly one JSON object;
// anything else there is a failure of the contract, not of the scenario.
export const check = (
  repo: Repo,
  roots: ReadonlyArray<string>,
  options: CliOptions = {},
): CheckResult => {
  const result = cli(repo, ["check", "--json", ...roots], options);
  let json: CheckJson;
  try {
    json = JSON.parse(result.stdout) as CheckJson;
  } catch (cause) {
    throw new Error(
      `check --json did not print one JSON object (exit ${String(result.code)}).\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\n${String(cause)}`,
    );
  }
  return { ...result, json };
};

export const fingerprintsOf = (json: CheckJson): ReadonlyArray<string> =>
  json.violations.map((one) => one.fingerprint).sort();

export const reportableOf = (json: CheckJson): ReadonlyArray<string> =>
  json.violations
    .filter((one) => !one.baselined)
    .map((one) => one.fingerprint)
    .sort();
