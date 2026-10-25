import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { makeMeasureCommandsClientLive } from "./measure-commands.client-live.js";

const scratch = (): string => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "goodbones-commands-")));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  return root;
};

describe("makeMeasureCommandsClientLive", () => {
  it("runs the command through the shell from the repository root, and answers its stdout", () => {
    const root = scratch();
    const client = makeMeasureCommandsClientLive(root);

    expect(client.outputOf("printf 7")).toBe("7");
    expect(client.outputOf("pwd")?.trim()).toBe(root);
  });

  it("reads the output whatever the command exits with", () => {
    expect(makeMeasureCommandsClientLive(scratch()).outputOf("printf 3; exit 1")).toBe("3");
  });
});
