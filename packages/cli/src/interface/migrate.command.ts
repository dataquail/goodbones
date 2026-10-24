import { existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import {
  decodeManifest,
  findManifestFile,
  formatManifestYaml,
  readManifestFile,
} from "@goodbones/core";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { type CliFailure, fail, report } from "../output.js";
import { SCHEMA_HEADER } from "./init.command.js";

// The same manifest as a data file. Nothing is hoisted into `defs` — which
// subtrees are worth naming is the author's call — and comments do not
// survive, since no tool carries them across; the report says so.
export const migrate = (
  repoRoot: string,
  configFilename?: string,
): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const from = yield* Effect.try({
      try: () =>
        configFilename === undefined
          ? findManifestFile(repoRoot)
          : path.resolve(repoRoot, configFilename),
      catch: (cause) => fail(String(cause)),
    });

    if (![".mjs", ".js", ".cjs"].includes(path.extname(from))) {
      return yield* Effect.fail(
        fail(
          `${path.basename(from)} is already a data file. \`migrate\` reads a JavaScript ` +
            `manifest and writes the same policy as architecture.yaml.`,
        ),
      );
    }

    const to = path.resolve(repoRoot, "architecture.yaml");

    if (existsSync(to)) {
      return yield* Effect.fail(
        fail("architecture.yaml already exists; `migrate` does not overwrite it."),
      );
    }

    const read = yield* Effect.tryPromise({
      try: () => readManifestFile(from),
      catch: (cause) => fail(String(cause)),
    });

    // Written only if it decodes: a manifest that does not load as a module
    // is not going to load as YAML either, and the error names why.
    const decoded = decodeManifest(from, read.manifest);

    if (Result.isFailure(decoded)) return yield* Effect.fail(fail(decoded.failure.message));

    yield* Effect.sync(() => {
      writeFileSync(to, `${SCHEMA_HEADER}\n${formatManifestYaml(read.manifest)}`);
    });
    yield* report([
      `wrote architecture.yaml from ${path.basename(from)}.`,
      "",
      "Comments were not carried over; port the ones worth keeping by hand.",
      `Then delete ${path.basename(from)}: a repository with two manifests is refused.`,
    ]);
  });
