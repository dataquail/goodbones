import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { check, type CheckJson, cli } from "../cli.js";
import { exports, imports, source } from "../profile.js";
import { createRepo, MANIFEST_FILENAMES, type ManifestFormat, type Repo } from "../repo.js";

// The same policy in each of the manifest's forms reports the same thing;
// two forms at once are refused; `migrate` rewrites the module form as data.

const policy = (repo: Repo): Readonly<Record<string, unknown>> => ({
  resolve: { scopes: [repo.profile.scope], unresolved: "off" },
  defs: {
    "no-state": {
      message: "`{name}` puts state in the View.",
      subject: "calls",
      match: "use[A-Z]*",
      allow: ["useAtomValue"],
    },
  },
  tree: {
    "src/": {
      message: "src/ may reach only itself.",
      layout: "open",
      imports: { message: "src/ may reach only itself.", allow: ["src/**"] },
      children: {
        "*.view.ts": { members: [{ use: "no-state" }] },
      },
    },
  },
});

const FILES = {
  "src/thing.view.ts": source({
    imports: [{ from: "../lib/x.ts", names: ["x"] }],
    declares: [{ calls: "useState" }],
  }),
  "lib/x.ts": exports("x"),
  "src/other.ts": imports("./thing.view.ts"),
};

const EXPECTED = [
  "import|src/imports|src/thing.view.ts|lib/x.ts",
  "member|src/*.view.ts/members-0|src/thing.view.ts|useState",
];

// The report, less the field that names the file it was read from.
const sansManifest = (json: CheckJson): Omit<CheckJson, "manifest"> => {
  const { manifest: _manifest, ...rest } = json;
  return rest;
};

let repo: Repo;

beforeAll(() => {
  repo = createRepo({ files: FILES });
});

afterAll(() => {
  repo.dispose();
});

const withOnly = (format: ManifestFormat): void => {
  for (const file of Object.values(MANIFEST_FILENAMES)) repo.remove(file);
  repo.writeManifest(policy(repo), format);
};

describe.sequential("manifest formats", () => {
  it("reports the same thing as yaml, json and a module", () => {
    const reports = (["yaml", "json", "mjs"] as const).map((format) => {
      withOnly(format);
      const result = check(repo, ["src", "lib"]);
      expect(result.code).toBe(1);
      expect(result.json.manifest.path).toBe(MANIFEST_FILENAMES[format]);
      expect(result.json.violations.map((one) => one.fingerprint).sort()).toEqual(EXPECTED);
      return sansManifest(result.json);
    });
    expect(reports[1]).toEqual(reports[0]);
    expect(reports[2]).toEqual(reports[0]);
  });

  it("refuses a repository holding two manifests, naming both", () => {
    withOnly("yaml");
    repo.writeManifest(policy(repo), "mjs");
    const refused = cli(repo, ["check", "--json", "src"]);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("more than one architecture manifest");
    expect(refused.stderr).toContain("architecture.yaml");
    expect(refused.stderr).toContain("architecture.config.mjs");
  });

  it("migrates the module form to yaml that reports identically", () => {
    withOnly("mjs");
    const before = sansManifest(check(repo, ["src", "lib"]).json);

    const migrated = cli(repo, ["migrate"]);
    expect(migrated.code, migrated.stderr).toBe(0);
    expect(migrated.stdout).toContain("wrote architecture.yaml from architecture.config.mjs");
    expect(repo.read("architecture.yaml")).toMatch(/^# yaml-language-server: \$schema=/);

    repo.remove("architecture.config.mjs");
    const after = check(repo, ["src", "lib"]);
    expect(after.json.manifest.path).toBe("architecture.yaml");
    expect(sansManifest(after.json)).toEqual(before);
  });
});
