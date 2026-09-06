import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  type Node,
  type Pair,
  parseDocument,
  stringify,
} from "yaml";

import { ConfigInvalid } from "../domain/architecture-error.js";
import type {
  ManifestLocator,
  ManifestPath,
  ManifestPosition,
} from "../domain/manifest-location.js";
import { expandIncludes, type SourceDocument } from "./manifest-include.js";

// The manifest, as the files on disk state it, before any decoding. A data
// file — YAML, or JSON, which YAML 1.2 contains — is what any host in any
// language can read, and is the form the docs are written in. A JavaScript
// module is the escape hatch a Node host alone honours: for a manifest
// generated from other data, and for what the ecosystem expects of a config
// file. Either may `include` further data files, so a monorepo's policy can
// live beside the packages it governs. Whichever it is, what comes out is one
// `unknown` value for the decoder, and, from the data formats, a way to turn
// a path in it back into a file and a line.

// In discovery order. A repository with none of these is told all four; one
// with more than one is refused, so nobody edits the wrong file for a week.
export const MANIFEST_FILENAMES = [
  "architecture.yaml",
  "architecture.yml",
  "architecture.json",
  "architecture.config.mjs",
] as const;

export type ManifestFile = {
  readonly configPath: string;
  readonly manifest: unknown;
  // Absent for a JavaScript module that includes nothing, which has no
  // positions to give.
  readonly locate: ManifestLocator | undefined;
  // Every file the manifest was read from, the root first: what a host that
  // caches or watches the policy has to look at.
  readonly files: ReadonlyArray<string>;
};

export const findManifestFile = (repoRoot: string): string => {
  const present = MANIFEST_FILENAMES.filter((name) => existsSync(path.resolve(repoRoot, name)));
  const [found] = present;
  if (found === undefined) {
    throw new ConfigInvalid({
      configPath: repoRoot,
      detail:
        `no architecture manifest found. Looked for ${MANIFEST_FILENAMES.join(", ")} ` +
        `in this directory; \`architecture init\` writes a starter architecture.yaml.`,
    });
  }
  if (present.length > 1) {
    throw new ConfigInvalid({
      configPath: repoRoot,
      detail:
        `more than one architecture manifest is present (${present.join(", ")}), and only one ` +
        `can be the policy. Delete the others, or name one with ARCHITECTURE_CONFIG.`,
    });
  }
  return path.resolve(repoRoot, found);
};

const extensionOf = (configPath: string): string => path.extname(configPath).toLowerCase();

const isDataManifest = (configPath: string): boolean =>
  [".yaml", ".yml", ".json"].includes(extensionOf(configPath));

const isModuleManifest = (configPath: string): boolean =>
  [".mjs", ".js", ".cjs"].includes(extensionOf(configPath));

// Whichever form the root takes, an `include` in it names a data file, read
// by the same parser; the locator that comes back answers across every file.
export const readManifestFile = async (configPath: string): Promise<ManifestFile> => {
  const root = isDataManifest(configPath)
    ? parseDataFile(configPath)
    : isModuleManifest(configPath)
      ? await readModule(configPath)
      : undefined;
  if (root === undefined) {
    throw new ConfigInvalid({
      configPath,
      detail:
        "a manifest is a .yaml, .yml or .json file, or a .mjs/.js module — " +
        `not ${JSON.stringify(path.basename(configPath))}.`,
    });
  }
  const assembled = expandIncludes(configPath, root, { exists: existsSync, read: parseDataFile });
  return {
    configPath,
    manifest: assembled.value,
    locate: assembled.locate,
    files: assembled.files,
  };
};

const readModule = async (configPath: string): Promise<SourceDocument> => {
  const module: unknown = await import(pathToFileURL(configPath).href).catch((cause: unknown) => {
    throw new ConfigInvalid({ configPath, detail: String(cause) });
  });
  const value =
    typeof module === "object" && module !== null && "default" in module ? module.default : module;
  return { value, locate: undefined };
};

// YAML 1.2 core schema, which is what a reader without a YAML background
// expects: `on` and `no` are strings, not booleans. Merge keys (`<<`) resolve,
// because the parser handles them before the manifest sees the document, and
// duplicate keys are refused rather than last-one-wins. A tag the parser does
// not know is refused too — a manifest is data, and a `!!js/function` in it
// would be a manifest only one runtime could read.
const parseDataFile = (configPath: string): SourceDocument => {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (cause) {
    throw new ConfigInvalid({ configPath, detail: String(cause) });
  }

  const lines = new LineCounter();
  const document = parseDocument(text, {
    merge: true,
    uniqueKeys: true,
    customTags: [],
    lineCounter: lines,
    // A JSON file is read by the same parser; strict JSON is valid YAML.
    schema: "core",
  });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0) {
    const file = path.basename(configPath);
    throw new ConfigInvalid({
      configPath,
      detail:
        "the manifest does not parse:\n" +
        problems
          .map((problem) => {
            const [position] = problem.linePos ?? [];
            const at =
              position === undefined
                ? ""
                : `${file}:${String(position.line)}:${String(position.col)}  `;
            return `  ${at}${problem.code}: ${problem.message.split("\n")[0] ?? problem.message}`;
          })
          .join("\n"),
    });
  }

  return {
    value: document.toJS({ mapAsMap: false }) as unknown,
    locate: makeLocator(document, lines),
  };
};

const keyMatches = (pair: Pair, segment: PropertyKey): boolean =>
  isScalar(pair.key) && String(pair.key.value) === String(segment);

// Walks the document's own tree by the decoder's path and answers with the
// position of the deepest thing that exists along it. A map key is reported
// at the key, where the reader's eye lands; a sequence item at the item. A
// key merged in through `<<` lives in the fragment it came from, which the
// walk cannot see — the reader then gets the position of the map instead.
const makeLocator = (document: Document, lines: LineCounter): ManifestLocator => {
  const positionOf = (node: Node | null | undefined): ManifestPosition | null => {
    const offset = node?.range?.[0];
    if (offset === undefined) return null;
    const { col, line } = lines.linePos(offset);
    return { line, column: col };
  };
  const resolved = (node: unknown): unknown => (isAlias(node) ? node.resolve(document) : node);

  return (manifestPath: ManifestPath) => {
    let current: unknown = resolved(document.contents);
    let position = positionOf(document.contents);
    for (const segment of manifestPath) {
      if (isMap(current)) {
        const pair = current.items.find((one) => keyMatches(one, segment));
        if (pair === undefined) break;
        position = positionOf(isScalar(pair.key) ? pair.key : null) ?? position;
        current = resolved(pair.value);
      } else if (isSeq(current) && typeof segment === "number") {
        const item = current.items[segment];
        if (item === undefined) break;
        position = positionOf(item as Node) ?? position;
        current = resolved(item);
      } else {
        break;
      }
    }
    return position;
  };
};

// The value as a YAML document, for `architecture migrate` and anything else
// that writes a manifest rather than reads one. Strings are quoted whenever
// the core schema would read them as something else, and a multi-line one —
// a probe source — becomes a block scalar.
export const formatManifestYaml = (manifest: unknown): string =>
  stringify(manifest, { lineWidth: 100, blockQuote: "literal", schema: "core" });
