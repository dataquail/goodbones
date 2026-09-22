// A campaign's `report` term names a pattern no parser of ours sees: a type
// error, a lint finding from another tool, anything a program prints one
// line per occurrence. This is the vocabulary such a report is read into —
// a diagnostic with a file, a position, a code and a message — and the
// readers for the formats a report comes in. Pure: text in, diagnostics out.
// Running the command or reading the file is the report source's business.

export type Diagnostic = {
  // Repo-relative, forward slashes.
  readonly file: string;
  // Zero-based, as a syntax match's range is.
  readonly line: number;
  readonly column: number;
  // `TS2551`, `eslint(no-unused-vars)`, `no-debugger` — whatever the tool
  // calls the kind of finding; `""` when the format carries none.
  readonly code: string;
  // The first line of the message.
  readonly message: string;
};

export type ReportFormat = "tsc" | "eslint" | "oxlint" | "regex";

export type ParseReportOptions = {
  // Absolute paths in the report are made relative to this.
  readonly repoRoot: string;
  // `regex` only: a pattern with named groups `file` and `line`, and
  // optionally `column`, `code` and `message`; one diagnostic per line that
  // matches, positions one-based as tools print them.
  readonly pattern?: string | undefined;
};

const relativeTo = (repoRoot: string, file: string): string => {
  const slashed = file.replaceAll("\\", "/");
  const root = repoRoot.replaceAll("\\", "/").replace(/\/$/, "");
  const relative =
    slashed === root
      ? ""
      : slashed.startsWith(`${root}/`)
        ? slashed.slice(root.length + 1)
        : slashed;
  return relative.replace(/^\.\//, "");
};

const oneBased = (value: string | undefined, fallback = 1): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed - 1 : fallback - 1;
};

const firstLine = (message: string): string => message.split(/\r?\n/, 1)[0]?.trim() ?? "";

// `src/a.ts(12,5): error TS2551: Property 'x' does not exist…`, one per
// line, with the continuation lines tsc indents beneath a message ignored —
// the first line is the message.
const TSC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

const parseTsc = (text: string, options: ParseReportOptions): ReadonlyArray<Diagnostic> => {
  const found: Array<Diagnostic> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = TSC_LINE.exec(line);
    if (match === null) continue;
    const [, file = "", row, column, code = "", message = ""] = match;
    found.push({
      file: relativeTo(options.repoRoot, file),
      line: oneBased(row),
      column: oneBased(column),
      code,
      message: firstLine(message),
    });
  }
  return found;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const parseJson = (text: string, format: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`a ${format} report is JSON, and this one does not parse: ${String(cause)}`);
  }
};

// `eslint --format json`: one object per file with its messages. A message
// with no `ruleId` (a parse error) carries the code `""`.
const parseEslint = (text: string, options: ParseReportOptions): ReadonlyArray<Diagnostic> => {
  const parsed = parseJson(text, "eslint");
  if (!Array.isArray(parsed)) throw new Error("an eslint report is a JSON array of files");
  const found: Array<Diagnostic> = [];
  for (const entry of parsed) {
    if (!isRecord(entry) || !Array.isArray(entry.messages)) continue;
    const file = relativeTo(options.repoRoot, asString(entry.filePath));
    for (const message of entry.messages) {
      if (!isRecord(message)) continue;
      found.push({
        file,
        line: (asNumber(message.line) ?? 1) - 1,
        column: (asNumber(message.column) ?? 1) - 1,
        code: asString(message.ruleId),
        message: firstLine(asString(message.message)),
      });
    }
  }
  return found;
};

// `oxlint --format json`: `{ diagnostics: [{ filename, code, message,
// labels: [{ span: { line, column } }] }] }`, positions one-based.
const parseOxlint = (text: string, options: ParseReportOptions): ReadonlyArray<Diagnostic> => {
  const parsed = parseJson(text, "oxlint");
  if (!isRecord(parsed) || !Array.isArray(parsed.diagnostics)) {
    throw new Error("an oxlint report is a JSON object with a `diagnostics` array");
  }
  const found: Array<Diagnostic> = [];
  for (const entry of parsed.diagnostics) {
    if (!isRecord(entry)) continue;
    const labels: ReadonlyArray<unknown> = Array.isArray(entry.labels) ? entry.labels : [];
    const label: unknown = labels[0];
    const span = isRecord(label) && isRecord(label.span) ? label.span : {};
    found.push({
      file: relativeTo(options.repoRoot, asString(entry.filename)),
      line: (asNumber(span.line) ?? 1) - 1,
      column: (asNumber(span.column) ?? 1) - 1,
      code: asString(entry.code),
      message: firstLine(asString(entry.message)),
    });
  }
  return found;
};

const parseRegex = (text: string, options: ParseReportOptions): ReadonlyArray<Diagnostic> => {
  if (options.pattern === undefined) {
    throw new Error("a `regex` report needs a `pattern` with named groups `file` and `line`");
  }
  const pattern = new RegExp(options.pattern);
  const found: Array<Diagnostic> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match === null) continue;
    const groups = match.groups ?? {};
    if (groups.file === undefined) continue;
    found.push({
      file: relativeTo(options.repoRoot, groups.file),
      line: oneBased(groups.line),
      column: oneBased(groups.column),
      code: groups.code ?? "",
      message: firstLine(groups.message ?? ""),
    });
  }
  return found;
};

export const parseReport = (
  format: ReportFormat,
  text: string,
  options: ParseReportOptions,
): ReadonlyArray<Diagnostic> => {
  switch (format) {
    case "tsc":
      return parseTsc(text, options);
    case "eslint":
      return parseEslint(text, options);
    case "oxlint":
      return parseOxlint(text, options);
    case "regex":
      return parseRegex(text, options);
  }
};

// One report from several outputs. A tool that takes one project at a time
// is run once per project, and a project's program includes the files of
// the projects it references, so one diagnostic is printed under several
// runs; it is one diagnostic. Kept once, at its first appearance, when
// identical in file, position, code and message.
export const uniqueDiagnostics = (diagnostics: Iterable<Diagnostic>): ReadonlyArray<Diagnostic> => {
  const seen = new Set<string>();
  const kept: Array<Diagnostic> = [];
  for (const one of diagnostics) {
    const key = JSON.stringify([one.file, one.line, one.column, one.code, one.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(one);
  }
  return kept;
};

// The diagnostics indexed by file, which is how a per-file evaluator asks
// for them.
export const indexByFile = (
  diagnostics: Iterable<Diagnostic>,
): ReadonlyMap<string, ReadonlyArray<Diagnostic>> => {
  const byFile = new Map<string, Array<Diagnostic>>();
  for (const one of diagnostics) {
    const found = byFile.get(one.file);
    if (found === undefined) byFile.set(one.file, [one]);
    else found.push(one);
  }
  return byFile;
};
