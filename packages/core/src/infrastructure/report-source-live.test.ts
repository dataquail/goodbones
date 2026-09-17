import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ReportUnavailable } from "../domain/architecture-error.js";
import { makeReportSourceLive } from "./report-source-live.js";

const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goodbones-report-"));
afterAll(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

const tscLine = (file: string, line: number, code: string, message: string) =>
  `${file}(${line},1): error ${code}: ${message}\n`;

describe("makeReportSourceLive", () => {
  it("runs a command once and answers every file from the same output", () => {
    const stamp = path.join(repoRoot, "runs");
    const reports = makeReportSourceLive(repoRoot);
    const spec = {
      command: `echo run >> runs; printf '${tscLine("src/a.ts", 3, "TS2551", "no")}'`,
      format: "tsc" as const,
    };
    expect(reports.diagnosticsOf(spec, "src/a.ts").map((one) => one.code)).toEqual(["TS2551"]);
    expect(reports.diagnosticsOf(spec, "src/b.ts")).toEqual([]);
    expect(reports.diagnosticsOf(spec, "src/a.ts")).toHaveLength(1);
    expect(fs.readFileSync(stamp, "utf8")).toBe("run\n");
  });

  it("reads a file the build wrote", () => {
    fs.writeFileSync(path.join(repoRoot, "tsc.txt"), tscLine("src/c.ts", 1, "TS1000", "x"));
    const reports = makeReportSourceLive(repoRoot);
    const spec = { file: "tsc.txt", format: "tsc" as const };
    expect(reports.diagnosticsOf(spec, "src/c.ts").map((one) => one.code)).toEqual(["TS1000"]);
  });

  // A command that cannot be spawned fails once. The plugin asks once per
  // file across a whole lint run, and a spawn the kernel refused for memory
  // is refused again on every retry — so the refusal is kept, as the report
  // would have been, and the second file gets the same error without a
  // second fork.
  it("keeps a spawn failure and throws the same one on every later ask", () => {
    const reports = makeReportSourceLive(path.join(repoRoot, "nowhere"));
    const spec = { command: "echo unreachable", format: "tsc" as const };
    const first = (() => {
      try {
        reports.diagnosticsOf(spec, "src/a.ts");
        return null;
      } catch (cause) {
        return cause;
      }
    })();
    expect(first).toBeInstanceOf(ReportUnavailable);
    expect((first as ReportUnavailable).kind).toBe("command");
    expect((first as ReportUnavailable).message).toContain("`echo unreachable` could not be run");
    expect((first as ReportUnavailable).message).toContain("named by `file:`");
    let second: unknown = null;
    try {
      reports.diagnosticsOf(spec, "src/b.ts");
    } catch (cause) {
      second = cause;
    }
    expect(second).toBe(first);
  });

  // A tool that checks one project at a time is run once per project; the
  // outputs are one report, and a diagnostic printed under two projects —
  // a program includes the files of the projects it references — is one.
  it("runs several commands as one report, keeping a diagnostic two of them print once", () => {
    const reports = makeReportSourceLive(repoRoot);
    const shared = tscLine("src/shared.ts", 2, "TS2551", "shared");
    const spec = {
      command: [
        `printf '${tscLine("src/a.ts", 1, "TS1000", "a")}${shared}'`,
        `printf '${shared}${tscLine("src/b.ts", 4, "TS1000", "b")}'`,
      ],
      format: "tsc" as const,
    };
    expect(reports.diagnosticsOf(spec, "src/a.ts").map((one) => one.code)).toEqual(["TS1000"]);
    expect(reports.diagnosticsOf(spec, "src/b.ts").map((one) => one.line)).toEqual([3]);
    expect(reports.diagnosticsOf(spec, "src/shared.ts")).toHaveLength(1);
  });

  it("reads several files the build wrote as one report", () => {
    fs.writeFileSync(path.join(repoRoot, "one.txt"), tscLine("src/d.ts", 1, "TS1", "x"));
    fs.writeFileSync(path.join(repoRoot, "two.txt"), tscLine("src/d.ts", 9, "TS2", "y"));
    const reports = makeReportSourceLive(repoRoot);
    const spec = { file: ["one.txt", "two.txt"], format: "tsc" as const };
    expect(reports.diagnosticsOf(spec, "src/d.ts").map((one) => one.code)).toEqual(["TS1", "TS2"]);
  });

  // `read` is what a host calls before any file asks: the commands run at
  // once rather than one after another, and what they said is kept for
  // `diagnosticsOf`, which then forks nothing.
  it("read runs the commands concurrently, once, and diagnosticsOf answers from what it kept", async () => {
    const stamp = path.join(repoRoot, "concurrent");
    const reports = makeReportSourceLive(repoRoot);
    // Each command waits for the other's mark before printing; run one
    // after another, the first would wait forever.
    const waitFor = (mine: string, theirs: string) =>
      `touch ${stamp}-${mine}; i=0; while [ ! -f ${stamp}-${theirs} ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done; ` +
      `echo ${mine} >> ${stamp}-runs; printf '${tscLine(`src/${mine}.ts`, 1, "TS1", mine)}'`;
    const spec = {
      command: [waitFor("x", "y"), waitFor("y", "x")],
      format: "tsc" as const,
    };
    await Promise.all([reports.read?.(spec), reports.read?.(spec)]);
    expect(reports.diagnosticsOf(spec, "src/x.ts").map((one) => one.code)).toEqual(["TS1"]);
    expect(reports.diagnosticsOf(spec, "src/y.ts").map((one) => one.code)).toEqual(["TS1"]);
    expect(fs.readFileSync(`${stamp}-runs`, "utf8").split("\n").filter(Boolean).sort()).toEqual([
      "x",
      "y",
    ]);
    await reports.read?.(spec);
    expect(fs.readFileSync(`${stamp}-runs`, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("read keeps a failure for diagnosticsOf to throw, naming the command that failed", async () => {
    const reports = makeReportSourceLive(path.join(repoRoot, "nowhere"));
    const spec = { command: ["echo one", "echo two"], format: "tsc" as const };
    await expect(reports.read?.(spec)).resolves.toBeUndefined();
    let failure: unknown = null;
    try {
      reports.diagnosticsOf(spec, "src/a.ts");
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(ReportUnavailable);
    expect((failure as ReportUnavailable).source).toBe("echo one");
  });

  it("keeps a missing file the same way, and says which step writes it", () => {
    const reports = makeReportSourceLive(repoRoot);
    const spec = { file: "missing.txt", format: "tsc" as const };
    expect(() => reports.diagnosticsOf(spec, "src/a.ts")).toThrow(ReportUnavailable);
    let again: unknown = null;
    try {
      reports.diagnosticsOf(spec, "src/b.ts");
    } catch (cause) {
      again = cause;
    }
    expect(again).toBeInstanceOf(ReportUnavailable);
    expect((again as ReportUnavailable).kind).toBe("file");
    expect((again as ReportUnavailable).message).toContain("written by an earlier step");
  });
});
