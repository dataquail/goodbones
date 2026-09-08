import { describe, expect, it } from "vitest";

import { FIXTURE } from "./fixture.test.js";
import { searchFiles } from "./search.js";

describe("searchFiles", () => {
  it("finds walked files by a piece of their path, shortest first, never a package", () => {
    expect(searchFiles(FIXTURE, "ER")).toEqual([
      { path: "src/app/server.ts", folder: "src/app" },
      { path: "src/domain/user.ts", folder: "src/domain" },
      { path: "src/domain/order.ts", folder: "src/domain" },
    ]);
    expect(searchFiles(FIXTURE, "effect")).toEqual([]);
  });

  it("finds nothing for an empty query", () => {
    expect(searchFiles(FIXTURE, "   ")).toEqual([]);
  });
});
