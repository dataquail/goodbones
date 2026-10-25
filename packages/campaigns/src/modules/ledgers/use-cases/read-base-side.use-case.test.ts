import { describe, expect, it } from "vitest";

import { makeBaseSidesClientFake } from "../infrastructure/clients/base-sides.client-fake.js";
import { makeGitClientFake } from "../infrastructure/clients/git.client-fake.js";
import { makeWorkspaceClientFake } from "../infrastructure/clients/workspace.client-fake.js";
import { fakes, load, TODO } from "./campaign.test-helper.js";
import { readBaseSideUseCase } from "./read-base-side.use-case.js";

describe("readBaseSideUseCase", () => {
  it("answers a commit's cached side without materializing the tree", async () => {
    const side = [{ id: "tidy", sectors: {}, hits: [] }];
    const baseSides = makeBaseSidesClientFake(new Map([["abc", side]]));
    const git = makeGitClientFake({ shas: { HEAD: "abc" } });
    const { policy } = load(TODO, { ...fakes(), git, baseSides });

    const base = await readBaseSideUseCase(policy, "HEAD", ["src"], () =>
      Promise.reject(new Error("not loaded")),
    );

    expect(base).toEqual(side);
    expect(git.materialized).toEqual([]);
  });

  it("evaluates the materialized tree, keeps the side by commit, and disposes of the tree", async () => {
    const baseSides = makeBaseSidesClientFake();
    const git = makeGitClientFake({ shas: { HEAD: "abc" }, trees: { HEAD: "/base" } });
    const workspace = makeWorkspaceClientFake({ files: { "/base": Object.keys(TODO) } });
    const { policy } = load(TODO, { ...fakes(), git, baseSides, workspace });
    const base = load(TODO).policy;
    const loaded: Array<string> = [];

    const side = await readBaseSideUseCase(policy, "HEAD", ["src"], (root) => {
      loaded.push(root);

      return Promise.resolve(base);
    });

    expect(loaded).toEqual(["/base"]);
    expect(side.map((one) => one.id)).toEqual(["tidy"]);
    // The base tree was walked through the workspace client, never the disk.
    expect(workspace.asked).toEqual([{ root: "/base", what: "files" }]);
    expect(Object.keys(side[0]?.sectors ?? {}).sort()).toEqual(["src/a", "src/b"]);
    expect(baseSides.written.get("abc")).toEqual(side);
    expect(git.materialized).toEqual([{ ref: "HEAD", disposed: true }]);
  });
});
