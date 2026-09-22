import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import * as path from "node:path";

import { ReportUnavailable } from "@goodbones/core";

import { type Diagnostic, indexByFile, parseReport, uniqueDiagnostics } from "../domain/report.js";
import { type ReportSource, reportSourcesOf, type ReportSpec } from "../ports/report-source.js";

// The report source on this host: runs a `report` term's commands from the
// repository root, or reads the files it names, and parses the output once
// — a report is about the whole repository, a campaign asks per file, and
// the plugin asks for one file at a time across a whole lint run. Cached
// per spec for the life of the process: the CLI is one process per `check`,
// and oxlint's language server is one process per editor session, which
// sees the report as of when it loaded the plugin. A report the build
// writes to a file is the predictable form for the editor, and for CI.
//
// A term may name several commands — a tool that checks one project at a
// time, run once per project — and their outputs are one report: parsed
// each, joined, and a diagnostic two of them print kept once. `read` runs
// them concurrently, as many at a time as the machine has cores, which is
// why both hosts call it before any file asks; `diagnosticsOf` with no
// answer kept runs them one after another, synchronously, and keeps that.
//
// A non-zero exit is not a failure — `tsc` exits 2 when there are errors,
// which is the case the term exists for. A command that cannot be spawned,
// or a file that is not there, is — and that failure is cached as the report
// would have been, so the second file to ask gets the same answer without a
// second spawn. The command is forked from the asking process; under the
// oxlint plugin that is the linter, which Linux refuses to fork once its AST
// buffers have merged into one mapping larger than RAM and swap — so the
// plugin asks at load, and retrying per file would only repeat the refusal.

const MAX_BUFFER = 256 * 1024 * 1024;

const fileTextOf = (repoRoot: string, file: string): string => {
  const at = path.resolve(repoRoot, file);
  try {
    return readFileSync(at, "utf8");
  } catch (cause) {
    throw new ReportUnavailable({ kind: "file", source: file, detail: String(cause) });
  }
};

const commandTextSync = (repoRoot: string, command: string): string => {
  const run = spawnSync(command, {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (run.error !== undefined) {
    throw new ReportUnavailable({ kind: "command", source: command, detail: run.error.message });
  }
  return run.stdout;
};

const commandText = (repoRoot: string, command: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: repoRoot,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Array<Buffer> = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BUFFER) {
        child.kill();
        reject(
          new ReportUnavailable({
            kind: "command",
            source: command,
            detail: `stdout exceeded ${String(MAX_BUFFER)} bytes`,
          }),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", (cause) => {
      reject(new ReportUnavailable({ kind: "command", source: command, detail: cause.message }));
    });
    child.on("close", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });

// `work` over `items`, at most `lanes` at a time, answers in order.
const inLanes = async <A, B>(
  items: ReadonlyArray<A>,
  lanes: number,
  work: (item: A) => Promise<B>,
): Promise<ReadonlyArray<B>> => {
  const answers = new Array<B>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      answers[index] = await work(items[index] as A);
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, lane));
  return answers;
};

// One command named as a string and the same one as a list of one are the
// same report.
const keyOf = (spec: ReportSpec): string =>
  JSON.stringify([
    spec.file === undefined ? "command" : "file",
    reportSourcesOf(spec),
    spec.format,
    spec.pattern ?? null,
  ]);

type Indexed = ReadonlyMap<string, ReadonlyArray<Diagnostic>>;

export const makeReportSourceLive = (repoRoot: string): ReportSource => {
  const cache = new Map<string, Indexed | ReportUnavailable>();
  const reading = new Map<string, Promise<void>>();

  // The outputs, in the order named, as one report.
  const indexOf = (spec: ReportSpec, texts: ReadonlyArray<string>): Indexed =>
    indexByFile(
      uniqueDiagnostics(
        texts.flatMap((text) =>
          parseReport(spec.format, text, { repoRoot, pattern: spec.pattern }),
        ),
      ),
    );

  const answerSync = (spec: ReportSpec): Indexed | ReportUnavailable => {
    try {
      const texts = reportSourcesOf(spec).map((source) =>
        spec.file === undefined ? commandTextSync(repoRoot, source) : fileTextOf(repoRoot, source),
      );
      return indexOf(spec, texts);
    } catch (cause) {
      if (cause instanceof ReportUnavailable) return cause;
      throw cause;
    }
  };

  const answer = async (spec: ReportSpec): Promise<Indexed | ReportUnavailable> => {
    try {
      const sources = reportSourcesOf(spec);
      const texts =
        spec.file === undefined
          ? await inLanes(sources, availableParallelism(), (command) =>
              commandText(repoRoot, command),
            )
          : sources.map((file) => fileTextOf(repoRoot, file));
      return indexOf(spec, texts);
    } catch (cause) {
      if (cause instanceof ReportUnavailable) return cause;
      throw cause;
    }
  };

  const read = (spec: ReportSpec): Promise<void> => {
    const key = keyOf(spec);
    if (cache.has(key)) return Promise.resolve();
    const pending = reading.get(key);
    if (pending !== undefined) return pending;
    const started = answer(spec).then((found) => {
      cache.set(key, found);
      reading.delete(key);
    });
    reading.set(key, started);
    return started;
  };

  return {
    read,
    diagnosticsOf: (spec, file) => {
      const key = keyOf(spec);
      let found = cache.get(key);
      if (found === undefined) {
        found = answerSync(spec);
        cache.set(key, found);
      }
      if (found instanceof ReportUnavailable) throw found;
      return found.get(file) ?? [];
    },
  };
};
