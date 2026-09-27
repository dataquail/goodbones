import { describe, expect, it } from "vitest";

import { atlas, edge } from "./fixture.test-helper.js";
import {
  arcsOf,
  foldersRevealing,
  initiallyExpanded,
  relationsOf,
  rowIndexOf,
  rowsOf,
} from "./rows.js";

// The tree's geometry: rows in the order a listing reads, arcs between the
// rows the edges land on, and a collapsed folder standing in for its files.

const everyFolder = (): ReadonlySet<string> =>
  new Set(atlas().folders.map((folder) => folder.path));

describe("initiallyExpanded", () => {
  it("opens the roots and leaves every folder under them collapsed", () => {
    expect([...initiallyExpanded(atlas())]).toEqual(["svc"]);
  });
});

describe("foldersRevealing", () => {
  it("opens every folder above a path, and the folder itself when asked", () => {
    expect(foldersRevealing(atlas(), "svc/domain/repo.go", false)).toEqual(["svc", "svc/domain"]);
    expect(foldersRevealing(atlas(), "svc/domain", false)).toEqual(["svc"]);
    expect(foldersRevealing(atlas(), "svc/domain", true)).toEqual(["svc", "svc/domain"]);
    expect(foldersRevealing(atlas(), "elsewhere/x.go", true)).toEqual([]);
  });
});

describe("rowsOf", () => {
  it("lists folders before files, each alphabetically, walking into the expanded", () => {
    const all = rowsOf(atlas(), everyFolder());
    expect(all.map((row) => `${row.kind}:${row.path}`)).toEqual([
      "folder:svc",
      "folder:svc/adapters",
      "file:svc/adapters/pg.go",
      "folder:svc/domain",
      "file:svc/domain/model.go",
      "file:svc/domain/repo.go",
      "file:svc/main.go",
    ]);
    expect(all[0]).toMatchObject({ kind: "folder", depth: 0, files: 4, violations: 1 });
    expect(all[2]).toMatchObject({ depth: 2 });
  });

  it("hides what a collapsed folder holds, and counts it on the folder", () => {
    const rows = rowsOf(atlas(), new Set(["svc"]));
    expect(rows.map((row) => row.path)).toEqual([
      "svc",
      "svc/adapters",
      "svc/domain",
      "svc/main.go",
    ]);
    expect(rows[2]).toMatchObject({ kind: "folder", expanded: false, files: 2 });
  });
});

describe("arcsOf", () => {
  it("draws every edge between the rows it lands on, and folds hidden files onto their folder", () => {
    const expanded = everyFolder();
    const rows = rowsOf(atlas(), expanded);
    const at = rowIndexOf(rows, expanded);
    const arcs = arcsOf(atlas(), rows, expanded);
    expect(arcs).toHaveLength(3);
    expect(arcs.find((arc) => arc.refused)).toMatchObject({
      from: at("svc/adapters/pg.go"),
      to: at("svc/main.go"),
    });

    const collapsed = new Set(["svc"]);
    const fewer = rowsOf(atlas(), collapsed);
    const folded = arcsOf(atlas(), fewer, collapsed);
    // repo → model is inside the collapsed domain/ and is not drawn; the
    // other two land on the folder rows.
    expect(folded).toHaveLength(2);
    const index = rowIndexOf(fewer, collapsed);
    expect(index("svc/domain/repo.go")).toBe(index("svc/domain/model.go"));
    expect(folded.map((arc) => [arc.from, arc.to])).toEqual(
      expect.arrayContaining([
        [index("svc/main.go"), index("svc/domain")],
        [index("svc/adapters"), index("svc/main.go")],
      ]),
    );
  });
});

describe("relationsOf", () => {
  it("names a file reached both ways, whichever edge comes first", () => {
    const both = {
      ...atlas(),
      edges: [...atlas().edges, edge("svc/main.go", "svc/adapters/pg.go")],
    };
    expect(relationsOf(both, "svc/main.go", false).get("svc/adapters/pg.go")).toBe("both");
    const reversed = { ...both, edges: [...both.edges].reverse() };
    expect(relationsOf(reversed, "svc/main.go", false).get("svc/adapters/pg.go")).toBe("both");
    // A folder reached through one file each way is reached both ways too.
    expect(relationsOf(both, "svc/domain", true).get("svc/main.go")).toBe("importer");
  });

  it("names what a file reaches, what reaches it, and what it owes", () => {
    const withOwed = {
      ...atlas(),
      files: atlas().files.map((file) =>
        file.path === "svc/main.go"
          ? {
              ...file,
              requires: [{ sibling: "svc/main_test.go", present: false, rule: "svc/requires" }],
            }
          : file,
      ),
    };
    const relations = relationsOf(withOwed, "svc/main.go", false);
    expect([...relations.entries()]).toEqual([
      ["svc/main.go", "focus"],
      ["svc/domain/repo.go", "dep"],
      ["svc/adapters/pg.go", "importer"],
      ["svc/main_test.go", "sibling"],
    ]);
  });

  it("treats a folder as everything under it", () => {
    const relations = relationsOf(atlas(), "svc/domain", true);
    expect(relations.get("svc/domain/repo.go")).toBe("within");
    expect(relations.get("svc/domain/model.go")).toBe("within");
    expect(relations.get("svc/main.go")).toBe("importer");
    expect(relationsOf(atlas(), null, false).size).toBe(0);
  });
});
