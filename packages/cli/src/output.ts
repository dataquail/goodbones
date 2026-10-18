import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// What every command shares: how it fails, and how it writes. Its own module
// so the campaigns glue under `campaigns/` speaks the same way without
// reaching `run.ts`, which would close a cycle through the import that loads
// the glue.

export const CliFailure = Schema.TaggedStruct("CliFailure", { message: Schema.String });

export type CliFailure = typeof CliFailure.Type;

export const fail = (message: string): CliFailure => CliFailure.make({ message });

export const report = (lines: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const line of lines) process.stdout.write(`${line}\n`);
  });

export const count = (n: number, noun: string, plural = `${noun}s`): string =>
  `${String(n)} ${n === 1 ? noun : plural}`;
