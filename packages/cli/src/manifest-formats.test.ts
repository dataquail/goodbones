import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { decodeManifest, readManifestFile } from "@goodbones/core";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { run } from "./run.js";

// The manifest in each of its forms, through the CLI end to end: a YAML
// repository reports what a module one does, a decode error names a line,
// and the two commands that write a manifest rather than read one.

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, "../.tmp-cli-formats");

const write = (root: string, file: string, source: string) => {
  const at = path.join(root, file);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, source);
};

const captureRun = async (
  root: string,
  argv: ReadonlyArray<string>,
  configFilename?: string,
): Promise<{ readonly ok: boolean; readonly output: string; readonly error: string }> => {
  const chunks: Array<string> = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(String(chunk));

    return true;
  };

  try {
    const exit = await Effect.runPromiseExit(run(root, argv, configFilename));
    const failure: unknown = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;

    const error =
      typeof failure === "object" && failure !== null && "message" in failure
        ? String(failure.message)
        : String(failure ?? "");

    return { ok: Exit.isSuccess(exit), output: chunks.join(""), error };
  } finally {
    process.stdout.write = original;
  }
};

const MODULE = `export default {
  resolve: { scopes: [{ files: "", language: "typescript", options: { tsconfig: "tsconfig.json" } }], unresolved: "off" },
  tree: {
    "src/": {
      message: "src/ may reach only itself.",
      imports: { message: "src/ may reach only itself.", allow: ["src/**"] },
      children: {
        "*.view.tsx": {
          members: [
            { message: "\`{name}\` puts state in the View.", subject: "calls", match: "use[A-Z]*", allow: ["useAtomValue"] },
          ],
        },
      },
    },
  },
};
`;

const YAML = `resolve:
  scopes:
    - files: ""
      language: typescript
      options: { tsconfig: tsconfig.json }
  unresolved: off
defs:
  no-state:
    message: "\`{name}\` puts state in the View."
    subject: calls
    match: "use[A-Z]*"
    allow: [useAtomValue]
tree:
  "src/":
    message: "src/ may reach only itself."
    imports:
      message: "src/ may reach only itself."
      allow: ["src/**"]
    children:
      "*.view.tsx":
        members:
          - use: no-state
`;

const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: "." } });

const sources = (root: string) => {
  write(root, "tsconfig.json", TSCONFIG);
  write(
    root,
    "src/thing.view.tsx",
    'import { x } from "../lib/x.ts";\nexport const V = () => useState(0);\n',
  );
  write(root, "lib/x.ts", "export const x = 1;\n");
};

beforeAll(() => {
  rmSync(scratch, { force: true, recursive: true });
  mkdirSync(scratch, { recursive: true });
});

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

describe("a YAML manifest", { concurrent: false }, () => {
  const root = path.join(scratch, "yaml");

  it("is discovered by name and reports what the module form does", async () => {
    sources(root);
    write(root, "architecture.yaml", YAML);
    const { error, ok, output } = await captureRun(root, ["check", "src", "lib"]);
    expect(ok, error).toBe(false);
    expect(output).toContain("src/thing.view.tsx");
    expect(output).toContain("`useState` puts state in the View.");
    expect(output).toContain("src/ may reach only itself.");
  });

  it("is named by ARCHITECTURE_CONFIG when it is not called architecture.yaml", async () => {
    write(root, "policy/strict.yml", YAML);
    const { output } = await captureRun(root, ["check", "src"], "policy/strict.yml");
    expect(output).toContain("puts state in the View");
  });

  it("names the file, line and column of a decode error", async () => {
    write(root, "architecture.yaml", YAML.replace("subject: calls", "subject: call"));
    const { error, ok } = await captureRun(root, ["check", "src"]);
    expect(ok).toBe(false);
    expect(error).toMatch(
      /architecture\.yaml:10:5 {2}defs\["no-state"\]\.subject: Expected "members" \| "calls", got "call"/,
    );
    expect(error).toMatch(/via `use: "no-state"` at architecture\.yaml:22:13/);
  });

  it("is refused beside a second manifest", async () => {
    write(root, "architecture.yaml", YAML);
    write(root, "architecture.config.mjs", MODULE);
    const { error, ok } = await captureRun(root, ["check", "src"]);
    expect(ok).toBe(false);
    expect(error).toMatch(/more than one architecture manifest/);
  });
});

describe("architecture init", { concurrent: false }, () => {
  const root = path.join(scratch, "init");

  it("writes a starter manifest that loads, and says what to run next", async () => {
    mkdirSync(path.join(root, "src"), { recursive: true });
    write(root, "tsconfig.json", TSCONFIG);
    write(root, "src/main.ts", 'import "node:path";\nexport const main = 1;\n');
    const wrote = await captureRun(root, ["init"]);
    expect(wrote.ok, wrote.error).toBe(true);
    expect(wrote.output).toContain("wrote architecture.yaml");
    expect(wrote.output).toContain("architecture check");

    const text = readFileSync(path.join(root, "architecture.yaml"), "utf8");
    expect(text).toMatch(
      /^# yaml-language-server: \$schema=https:\/\/dataquail\.github\.io\/goodbones\/schema\/architecture\.schema\.json\n/,
    );
    expect(text).toContain("limits:\n  unrestricted: 0\n  partial: 0");

    const checked = await captureRun(root, ["check", "src"]);
    expect(checked.ok, checked.error).toBe(true);
    expect(checked.output).toContain("1 files, 0 violations");
  });

  it("refuses to overwrite a manifest that exists", async () => {
    const { error, ok } = await captureRun(root, ["init"]);
    expect(ok).toBe(false);
    expect(error).toMatch(/architecture\.yaml already exists/);
  });
});

describe("architecture migrate", { concurrent: false }, () => {
  const root = path.join(scratch, "migrate");

  it("writes the module manifest as YAML that decodes to the same policy", async () => {
    sources(root);
    write(root, "architecture.config.mjs", MODULE);
    const { error, ok, output } = await captureRun(root, ["migrate"]);
    expect(ok, error).toBe(true);
    expect(output).toContain("wrote architecture.yaml from architecture.config.mjs");
    expect(output).toContain("Comments were not carried over");
    expect(output).toContain("delete architecture.config.mjs");

    const text = readFileSync(path.join(root, "architecture.yaml"), "utf8");
    expect(text).toMatch(/^# yaml-language-server: \$schema=/);

    const module = await readManifestFile(path.join(root, "architecture.config.mjs"));
    const yaml = await readManifestFile(path.join(root, "architecture.yaml"));

    const decoded = (read: typeof module) => {
      const result = decodeManifest(read.configPath, read.manifest);

      if (Result.isFailure(result)) throw result.failure;

      return result.success.manifest;
    };

    expect(decoded(yaml)).toEqual(decoded(module));
  });

  it("refuses to overwrite, and refuses a manifest that is already data", async () => {
    const twice = await captureRun(root, ["migrate"], "architecture.config.mjs");
    expect(twice.ok).toBe(false);
    expect(twice.error).toMatch(/architecture\.yaml already exists/);

    rmSync(path.join(root, "architecture.config.mjs"));
    const data = await captureRun(root, ["migrate"]);
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/architecture\.yaml is already a data file/);
    expect(existsSync(path.join(root, "architecture.yaml"))).toBe(true);
  });

  it("refuses a module that does not decode, writing nothing", async () => {
    const broken = path.join(scratch, "migrate-broken");
    sources(broken);
    write(broken, "architecture.config.mjs", MODULE.replace('subject: "calls"', 'subject: "call"'));
    const { error, ok } = await captureRun(broken, ["migrate"]);
    expect(ok).toBe(false);
    expect(error).toMatch(/does not decode/);
    expect(existsSync(path.join(broken, "architecture.yaml"))).toBe(false);
  });
});
