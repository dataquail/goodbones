// A `command` measure's output: the command run once from the repository
// root through the shell, its stdout whole. `null` for a command that could
// not be spawned. The exit status is not read: a tool that exits non-zero
// when the number is over its own threshold is still a tool that printed it.
export type MeasureCommandsClient = {
  readonly outputOf: (command: string) => string | null;
};
