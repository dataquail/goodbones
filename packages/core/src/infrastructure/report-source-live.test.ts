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
