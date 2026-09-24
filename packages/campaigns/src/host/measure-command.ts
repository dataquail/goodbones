import { spawnSync } from "node:child_process";

import { type CompiledMeasure, numberFromOutput } from "../core/campaigns.js";

// A `command` measure's number: the command run once from the repository
// root through the shell, its stdout read whole or through the measure's
// pattern. Cached per command for the life of the returned function, which
// the host makes once per evaluation — a number about the repository is
// one number however many sectors ask. A command that cannot be spawned, or
// whose output reads as no number, measures `NaN`, and `check` refuses it.
// The exit status is not read: a tool that exits non-zero when the number
// is over its own threshold is still a tool that printed the number.

const MAX_BUFFER = 64 * 1024 * 1024;

export const commandValues = (repoRoot: string): ((measure: CompiledMeasure) => number) => {
  const outputs = new Map<string, string | null>();
  const outputOf = (command: string): string | null => {
    if (outputs.has(command)) return outputs.get(command) ?? null;
    const run = spawnSync(command, {
      cwd: repoRoot,
      shell: true,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = run.error === undefined ? run.stdout : null;
    outputs.set(command, output);
    return output;
  };
  return (measure) => {
    if (measure.kind !== "command") return Number.NaN;
    const output = outputOf(measure.command);
    return output === null ? Number.NaN : numberFromOutput(measure, output);
  };
};
