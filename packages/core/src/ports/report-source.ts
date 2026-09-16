import type { Diagnostic, ReportFormat } from "../domain/report.js";

// What a `report` term names: a program to run from the repository root, or
// a file some earlier step wrote, and the format its output is read in.
export type ReportSpec = {
  readonly command?: string | undefined;
  readonly file?: string | undefined;
  readonly format: ReportFormat;
  // `regex` only.
  readonly pattern?: string | undefined;
};

// Answers a `report` term for one file. The live source runs the command
// once per process (a report is about the whole repository, and a campaign
// asks per file) and reads a file once; a fake answers from a table. The
// core never spawns anything.
export type ReportSource = {
  readonly diagnosticsOf: (spec: ReportSpec, file: string) => ReadonlyArray<Diagnostic>;
};

export const NO_REPORTS: ReportSource = { diagnosticsOf: () => [] };
