import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { ReportUnavailable } from "../domain/architecture-error.js";
import { type Diagnostic, indexByFile, parseReport } from "../domain/report.js";
import type { ReportSource, ReportSpec } from "../ports/report-source.js";

// The report source on this host: runs a `report` term's command from the
// repository root, or reads the file it names, and parses the output once —
// a report is about the whole repository, a campaign asks per file, and the
// plugin asks for one file at a time across a whole lint run. Cached per
// spec for the life of the process: the CLI is one process per `check`, and
// oxlint's language server is one process per editor session, which sees the
// report as of when it loaded the plugin. A report the build writes to a file
// is the predictable form for the editor, and for CI.
//
// A non-zero exit is not a failure — `tsc` exits 2 when there are errors,
// which is the case the term exists for. A command that cannot be spawned,
// or a file that is not there, is — and that failure is cached as the report
// would have been, so the second file to ask gets the same answer without a
// second spawn. The command runs inside the asking process; under the oxlint
// plugin that is the linter, and a fork of it can be refused on a small
// runner. Retrying per file would turn one refusal into one per file.

const MAX_BUFFER = 256 * 1024 * 1024;

const textOf = (repoRoot: string, spec: ReportSpec): string => {
  if (spec.file !== undefined) {
    const at = path.resolve(repoRoot, spec.file);
    try {
      return readFileSync(at, "utf8");
    } catch (cause) {
      throw new ReportUnavailable({ kind: "file", source: spec.file, detail: String(cause) });
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
    // DIAGNOSTIC (not for merge): what this process looked like when the
    // kernel refused the fork.
    if (process.platform === "linux") {
      try {
        const pick = (text: string, keys: RegExp) =>
          text
            .split("\n")
            .filter((line) => keys.test(line))
            .map((line) => line.replace(/\s+/g, " "))
            .join("; ");
        const status = pick(
          readFileSync("/proc/self/status", "utf8"),
          /^(VmPeak|VmSize|VmRSS|VmData|VmStk|VmSwap|Threads)/,
        );
        const meminfo = pick(
          readFileSync("/proc/meminfo", "utf8"),
          /^(MemTotal|MemAvailable|SwapTotal|SwapFree|CommitLimit|Committed_AS)/,
        );
        const overcommit = readFileSync("/proc/sys/vm/overcommit_memory", "utf8").trim();
        const maps = readFileSync("/proc/self/maps", "utf8")
          .split("\n")
          .map((line) => /^([0-9a-f]+)-([0-9a-f]+) (\S+) \S+ \S+ \S+\s*(.*)$/.exec(line))
          .filter((found): found is RegExpExecArray => found !== null)
          .map((found) => ({
            size: parseInt(found[2] ?? "0", 16) - parseInt(found[1] ?? "0", 16),
            perms: found[3] ?? "",
            name: found[4] ?? "",
          }))
          .sort((left, right) => right.size - left.size)
          .slice(0, 12)
          .map((one) => `${(one.size / 1048576).toFixed(0)}MB ${one.perms} ${one.name}`)
          .join(" | ");
        process.stderr.write(
          `[goodbones-diag] ${status}\n[goodbones-diag] overcommit=${overcommit}; ${meminfo}\n[goodbones-diag] ${maps}\n`,
        );
      } catch {
        // best effort
      }
    }
    throw new ReportUnavailable({ kind: "command", source: command, detail: run.error.message });
  }
  return run.stdout;
};

const keyOf = (spec: ReportSpec): string => JSON.stringify(spec);

type Indexed = ReadonlyMap<string, ReadonlyArray<Diagnostic>>;

export const makeReportSourceLive = (repoRoot: string): ReportSource => {
  const cache = new Map<string, Indexed | ReportUnavailable>();
  const answerOf = (spec: ReportSpec): Indexed | ReportUnavailable => {
    try {
      return indexByFile(
        parseReport(spec.format, textOf(repoRoot, spec), { repoRoot, pattern: spec.pattern }),
      );
    } catch (cause) {
      if (cause instanceof ReportUnavailable) return cause;
      throw cause;
    }
  };
  return {
    diagnosticsOf: (spec, file) => {
      const key = keyOf(spec);
      let answer = cache.get(key);
      if (answer === undefined) {
        answer = answerOf(spec);
        cache.set(key, answer);
      }
      if (answer instanceof ReportUnavailable) throw answer;
      return answer.get(file) ?? [];
    },
  };
};
