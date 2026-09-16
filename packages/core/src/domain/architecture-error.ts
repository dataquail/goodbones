import * as Schema from "effect/Schema";

// These errors surface through oxlint's plugin loader, which prints a stack and
// nothing else. The `message` override is what turns "ConfigInvalid" into an
// instruction the reader can act on.

export class ConfigInvalid extends Schema.TaggedErrorClass<ConfigInvalid>("ConfigInvalid")(
  "ConfigInvalid",
  { configPath: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `${this.configPath}: ${this.detail}`;
  }
}

export class PatternInvalid extends Schema.TaggedErrorClass<PatternInvalid>("PatternInvalid")(
  "PatternInvalid",
  {
    ruleName: Schema.String,
    field: Schema.String,
    pattern: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `rule "${this.ruleName}" has an uncompilable ${this.field} pattern ${JSON.stringify(
      this.pattern,
    )}: ${this.detail}`;
  }
}

// A `resolve.scopes` entry a language pack cannot build a resolver from: options
// it does not understand, or a language no pack answers to. Raised by the pack,
// without the config path, which the loader adds when it reports it.
export class ScopeInvalid extends Schema.TaggedErrorClass<ScopeInvalid>("ScopeInvalid")(
  "ScopeInvalid",
  {
    files: Schema.String,
    language: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `resolve scope ${JSON.stringify(this.files)} (${this.language}): ${this.detail}`;
  }
}

export class ImportUnresolved extends Schema.TaggedErrorClass<ImportUnresolved>("ImportUnresolved")(
  "ImportUnresolved",
  {
    fromFile: Schema.String,
    specifier: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.fromFile} imports "${this.specifier}", which does not resolve: ${this.detail}`;
  }
}

// A `report` term whose source cannot be read: a command that could not be
// spawned, or a file that is not there. The live source raises it once per
// spec and keeps it, as it would have kept the report, so a lint over eight
// hundred files does not attempt the spawn eight hundred times; the plugin
// catches it and reports it once. The message says what to do, because a
// command is run inside whichever process asks — the CLI, or oxlint with
// the plugin loaded, which is the linter itself — and that is where a spawn
// fails for memory the linter holds.
export class ReportUnavailable extends Schema.TaggedErrorClass<ReportUnavailable>(
  "ReportUnavailable",
)("ReportUnavailable", {
  // "command" or "file", and the value as authored.
  kind: Schema.Literals(["command", "file"]),
  source: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.kind === "command"
      ? `the report command \`${this.source}\` could not be run: ${this.detail}. The command ` +
          `runs inside the process that asks for the report — \`architecture check\`, or oxlint ` +
          `with the plugin loaded, which is the linter itself — so on a CI runner it can fail ` +
          `for memory the linter is holding. A report an earlier step writes, named by \`file:\` ` +
          `instead of \`command:\`, is the form for CI and the editor.`
      : `the report file ${this.source} cannot be read: ${this.detail}. A \`report\` term's ` +
          `\`file\` is written by an earlier step; run that first, or name a \`command\`.`;
  }
}
