import type { MeasureCommandsClient } from "../../domain/ports/clients/measure-commands.client.js";

// Each command's output, as a test states it; a command it does not name
// could not be spawned. What was asked is kept, in order.
export type MeasureCommandsClientFake = MeasureCommandsClient & {
  readonly asked: ReadonlyArray<string>;
};

export const makeMeasureCommandsClientFake = (
  outputs: Readonly<Record<string, string>> = {},
): MeasureCommandsClientFake => {
  const asked: Array<string> = [];

  return {
    outputOf: (command) => {
      asked.push(command);

      return outputs[command] ?? null;
    },
    asked,
  };
};
