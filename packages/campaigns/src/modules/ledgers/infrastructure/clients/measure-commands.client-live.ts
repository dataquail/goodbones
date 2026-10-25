import { spawnSync } from "node:child_process";

import type { MeasureCommandsClient } from "../../domain/ports/clients/measure-commands.client.js";

const MAX_BUFFER = 64 * 1024 * 1024;

// A `command` measure run from the repository root through the shell.
export const makeMeasureCommandsClientLive = (repoRoot: string): MeasureCommandsClient => ({
  outputOf: (command) => {
    const run = spawnSync(command, {
      cwd: repoRoot,
      shell: true,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });

    return run.error === undefined ? run.stdout : null;
  },
});
