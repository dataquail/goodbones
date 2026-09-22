import type { Diagnostic, ReportFormat } from "../domain/report.js";

// What a `report` term names: a program to run from the repository root, or
// a file some earlier step wrote — or several of either, read as one report
// — and the format the output is read in.
export type ReportSpec = {
  readonly command?: string | ReadonlyArray<string> | undefined;
  readonly file?: string | ReadonlyArray<string> | undefined;
  readonly format: ReportFormat;
  // `regex` only.
  readonly pattern?: string | undefined;
};

// The commands or files a spec names, as a list.
export const reportSourcesOf = (spec: ReportSpec): ReadonlyArray<string> => {
  const named = spec.command ?? spec.file ?? [];
  return typeof named === "string" ? [named] : named;
};

// Answers a `report` term for one file. The live source runs the commands
// once per process (a report is about the whole repository, and a campaign
// asks per file) and reads a file once; a fake answers from a table. The
// core never spawns anything.
//
// `read` is the host's chance to ask ahead: it reads the report — several
// commands at once — and keeps the answer, or the failure, for
// `diagnosticsOf` to hand back. Both hosts call it before any file is
// judged; a source that does not offer it is asked synchronously, one
// command after another, the first time a file asks.
export type ReportSource = {
  readonly diagnosticsOf: (spec: ReportSpec, file: string) => ReadonlyArray<Diagnostic>;
  readonly read?: ((spec: ReportSpec) => Promise<void>) | undefined;
};

export const NO_REPORTS: ReportSource = { diagnosticsOf: () => [] };
