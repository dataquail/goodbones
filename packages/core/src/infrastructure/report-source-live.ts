import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { type Diagnostic, indexByFile, parseReport } from "../domain/report.js";
import type { ReportSource, ReportSpec } from "../ports/report-source.js";

// The report source on this host: runs a `report` term's command from the
// repository root, or reads the file it names, and parses the output once —
// a report is about the whole repository, a campaign asks per file, and the
// plugin asks for one file at a time across a whole lint run. Cached per
// spec for the life of the process: the CLI is one process per `check`, and
// oxlint's language server is one process per editor session, which sees the
// report as of when it loaded the plugin. A report the build writes to a file
// is the predictable form for the editor.
//
// A non-zero exit is not a failure — `tsc` exits 2 when there are errors,
// which is the case the term exists for. A command that cannot be spawned,
// or a file that is not there, is.

const MAX_BUFFER = 256 * 1024 * 1024;

const textOf = (repoRoot: string, spec: ReportSpec): string => {
  if (spec.file !== undefined) {
    const at = path.resolve(repoRoot, spec.file);
    try {
      return readFileSync(at, "utf8");
    } catch (cause) {
      throw new Error(
        `the report file ${spec.file} cannot be read: ${String(cause)}. A \`report\` term's ` +
          `\`file\` is written by an earlier step; run that first, or name a \`command\`.`,
      );
    }
  }
  const command = spec.command ?? "";
  const run = spawnSync(command, {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (run.error !== undefined) {
    throw new Error(`the report command \`${command}\` could not be run: ${run.error.message}`);
  }
  return run.stdout;
};

const keyOf = (spec: ReportSpec): string => JSON.stringify(spec);

export const makeReportSourceLive = (repoRoot: string): ReportSource => {
  const cache = new Map<string, ReadonlyMap<string, ReadonlyArray<Diagnostic>>>();
  return {
    diagnosticsOf: (spec, file) => {
      const key = keyOf(spec);
      let indexed = cache.get(key);
      if (indexed === undefined) {
        indexed = indexByFile(
          parseReport(spec.format, textOf(repoRoot, spec), { repoRoot, pattern: spec.pattern }),
        );
        cache.set(key, indexed);
      }
      return indexed.get(file) ?? [];
    },
  };
};
