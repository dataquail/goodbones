import type { Diagnostic } from "../domain/report.js";
import type { ReportSource } from "../ports/report-source.js";

// Keyed by file: a test states which diagnostics another tool reported on
// which file, and never runs the tool. Every spec is answered alike.
export const makeReportSourceFake = (
  staged: Readonly<Record<string, ReadonlyArray<Omit<Diagnostic, "file">>>>,
): ReportSource => ({
  diagnosticsOf: (_spec, file) => (staged[file] ?? []).map((one) => ({ ...one, file })),
});
