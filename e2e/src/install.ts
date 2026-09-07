import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Repo } from "./repo.js";

// The packages as npm ships them: `pnpm pack` applies the manifest's `files`
// narrowing and rewrites `workspace:*` to versions, and the tarballs are laid
// out under the fixture's `node_modules/` the way an install lays them out —
// each package at its name, its third-party dependencies beside it, the bin
// linked under `.bin/`. No registry is involved: the dependencies are linked
// from this workspace's store, which is where an install would put the same
// versions.

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(here, "../..");

export const PACKAGES = ["core", "typescript", "cli", "oxlint"] as const;
export type Package = (typeof PACKAGES)[number];

export type Tarballs = Readonly<Record<Package, string>>;

export const packAll = (into: string): Tarballs => {
  const tarballs: Partial<Record<Package, string>> = {};
  for (const name of PACKAGES) {
    const destination = path.join(into, name);
    mkdirSync(destination, { recursive: true });
    const run = spawnSync("pnpm", ["pack", "--pack-destination", destination], {
      cwd: path.join(WORKSPACE, "packages", name),
      encoding: "utf8",
    });
    if (run.status !== 0) {
      throw new Error(`pnpm pack failed for ${name}:\n${run.stdout}\n${run.stderr}`);
    }
    const [tarball] = readdirSync(destination).filter((entry) => entry.endsWith(".tgz"));
    if (tarball === undefined) throw new Error(`pnpm pack wrote no tarball for ${name}`);
    tarballs[name] = path.join(destination, tarball);
  }
  return tarballs as Tarballs;
};

type PackageManifest = {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly bin?: Readonly<Record<string, string>>;
};

const link = (target: string, at: string): void => {
  if (existsSync(at)) return;
  mkdirSync(path.dirname(at), { recursive: true });
  symlinkSync(target, at, "dir");
};

export type Installed = {
  // Absolute path of each installed package.
  readonly packages: Readonly<Record<Package, string>>;
  // The `architecture` bin, as `.bin/` links it.
  readonly bin: string;
};

export const installPacked = (repo: Repo, tarballs: Tarballs): Installed => {
  const modules = repo.path("node_modules");
  const packages: Partial<Record<Package, string>> = {};

  for (const name of PACKAGES) {
    const destination = path.join(modules, "@goodbones", name);
    mkdirSync(destination, { recursive: true });
    const run = spawnSync(
      "tar",
      ["-xzf", tarballs[name], "-C", destination, "--strip-components=1"],
      { encoding: "utf8" },
    );
    if (run.status !== 0) throw new Error(`tar failed for ${name}:\n${run.stderr}`);
    packages[name] = destination;
  }

  let bin: string | null = null;
  for (const name of PACKAGES) {
    const installed = packages[name] ?? "";
    const manifest = JSON.parse(
      readFileSync(path.join(installed, "package.json"), "utf8"),
    ) as PackageManifest;

    // Third-party dependencies, from where this workspace installed them for
    // the same package: the versions the lockfile pinned.
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dependency.startsWith("@goodbones/")) continue;
      const source = path.join(WORKSPACE, "packages", name, "node_modules", dependency);
      link(realpathSync(source), path.join(modules, dependency));
    }

    for (const [command, target] of Object.entries(manifest.bin ?? {})) {
      const file = path.join(installed, target);
      chmodSync(file, 0o755);
      const at = path.join(modules, ".bin", command);
      link(path.relative(path.dirname(at), file), at);
      if (command === "architecture") bin = at;
    }
  }

  if (bin === null) throw new Error("the installed cli links no `architecture` bin");
  return { packages: packages as Installed["packages"], bin };
};
