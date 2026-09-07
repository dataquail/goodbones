import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { stringify as toYaml } from "yaml";

import { type FileContent, type Profile, typescript } from "./profile.js";

// A generated repository: the profile's support files, the stub packages, the
// source, and the manifest, under a temp directory outside this checkout.
//
// The directory is realpath'd because macOS's `/var` is a symlink to
// `/private/var`, and a resolver that realpaths its answers would otherwise
// hand back `../../..` paths for every edge.

export type ManifestFormat = "yaml" | "yml" | "json" | "mjs";

export const MANIFEST_FILENAMES: Readonly<Record<ManifestFormat, string>> = {
  yaml: "architecture.yaml",
  yml: "architecture.yml",
  json: "architecture.json",
  mjs: "architecture.config.mjs",
};

// A string is written verbatim; an object is serialized in the format.
export type ManifestContent = string | Readonly<Record<string, unknown>>;

export type RepoOptions = {
  readonly profile?: Profile;
  readonly files?: Readonly<Record<string, FileContent>>;
  // Externals to stub under `node_modules/`, each with the subpaths it exposes.
  readonly packages?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly manifest?: ManifestContent;
  readonly manifestFormat?: ManifestFormat;
};

export type Repo = {
  readonly root: string;
  readonly profile: Profile;
  readonly path: (file: string) => string;
  readonly write: (file: string, content: FileContent) => void;
  readonly writeManifest: (content: ManifestContent, format?: ManifestFormat) => string;
  readonly read: (file: string) => string;
  readonly exists: (file: string) => boolean;
  readonly remove: (file: string) => void;
  readonly dispose: () => void;
};

export const renderManifest = (content: ManifestContent, format: ManifestFormat): string => {
  if (typeof content === "string") return content;
  switch (format) {
    case "yaml":
    case "yml":
      return toYaml(content);
    case "json":
      return `${JSON.stringify(content, null, 2)}\n`;
    case "mjs":
      return `export default ${JSON.stringify(content, null, 2)};\n`;
  }
};

export const createRepo = (options: RepoOptions = {}): Repo => {
  const profile = options.profile ?? typescript;
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "goodbones-e2e-")));

  const at = (file: string): string => path.join(root, file);
  const writeText = (file: string, text: string): void => {
    mkdirSync(path.dirname(at(file)), { recursive: true });
    writeFileSync(at(file), text);
  };
  const write = (file: string, content: FileContent): void => {
    writeText(file, typeof content === "string" ? content : profile.render(content));
  };
  const writeManifest = (content: ManifestContent, format: ManifestFormat = "yaml"): string => {
    const file = MANIFEST_FILENAMES[format];
    writeText(file, renderManifest(content, format));
    return file;
  };

  for (const [file, text] of Object.entries(profile.support)) writeText(file, text);
  for (const [name, subpaths] of Object.entries(options.packages ?? {})) {
    for (const [file, text] of Object.entries(profile.stub(name, subpaths))) writeText(file, text);
  }
  for (const [file, content] of Object.entries(options.files ?? {})) write(file, content);
  if (options.manifest !== undefined) writeManifest(options.manifest, options.manifestFormat);

  return {
    root,
    profile,
    path: at,
    write,
    writeManifest,
    read: (file) => readFileSync(at(file), "utf8"),
    exists: (file) => existsSync(at(file)),
    remove: (file) => {
      rmSync(at(file), { force: true, recursive: true });
    },
    dispose: () => {
      rmSync(root, { force: true, recursive: true });
    },
  };
};
