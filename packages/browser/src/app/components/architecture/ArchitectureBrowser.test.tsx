// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArchitectureBrowser } from "./ArchitectureBrowser.js";
import { atlas, edge, file, folder } from "./fixture.test-helper.js";

// The browser under a pointer: hovering a file brings its edges forward and
// lights the node that governs it in the manifest; hovering a manifest line
// lights the files its node governs; a click keeps either and reports it.

afterEach(cleanup);

// jsdom lays nothing out, so it has no scrolling to do.
Element.prototype.scrollIntoView = () => undefined;

// The tree starts with only its roots open; these tests read the whole of it.
const renderOpen = (ui: React.JSX.Element) => {
  const result = render(ui);
  fireEvent.click(within(result.container).getByText("expand"));
  return result;
};

const arcs = (container: HTMLElement) => [
  ...container.querySelectorAll<SVGPathElement>("path.arc"),
];

describe.sequential("ArchitectureBrowser", () => {
  it("starts with the roots open and every folder under them collapsed", () => {
    const { container } = render(
      <ArchitectureBrowser atlas={atlas()} selection={null} onSelect={() => undefined} />,
    );
    expect([...container.querySelectorAll<HTMLElement>("li.row")].map((row) => row.title)).toEqual([
      "svc",
      "svc/adapters",
      "svc/domain",
      "svc/main.go",
    ]);
  });

  it("opens the tree down to a linked folder, and the folder itself", () => {
    const { container } = render(
      <ArchitectureBrowser atlas={atlas()} selection="svc/domain" onSelect={() => undefined} />,
    );
    const rows = within(container);
    expect(rows.getByTitle("svc/domain/repo.go")).toBeTruthy();
    expect(rows.queryByTitle("svc/adapters/pg.go")).toBeNull();
  });

  it("brings a later selection on screen without opening it", () => {
    const deep = {
      ...atlas(),
      folders: [...atlas().folders, folder("svc/domain/model", { node: "svc/domain" })],
      files: [...atlas().files, file("svc/domain/model/user.go", { node: "svc/domain" })],
    };
    const { container, rerender } = render(
      <ArchitectureBrowser atlas={deep} selection={null} onSelect={() => undefined} />,
    );
    expect(within(container).queryByTitle("svc/domain/model")).toBeNull();
    rerender(
      <ArchitectureBrowser atlas={deep} selection="svc/domain/model" onSelect={() => undefined} />,
    );
    expect(within(container).getByTitle("svc/domain/model")).toBeTruthy();
    expect(within(container).queryByTitle("svc/domain/model/user.go")).toBeNull();
  });

  it("draws every row and every arc, greyed", () => {
    const { container } = renderOpen(
      <ArchitectureBrowser atlas={atlas()} selection={null} onSelect={() => undefined} />,
    );
    expect(container.querySelectorAll("li.row")).toHaveLength(7);
    expect(arcs(container)).toHaveLength(3);
    expect(arcs(container).every((arc) => arc.classList.contains("dim"))).toBe(true);
    expect(container.querySelectorAll("li.line")).toHaveLength(6);
  });

  it("brings a hovered file's edges forward and lights its node in the manifest", () => {
    const { container } = renderOpen(
      <ArchitectureBrowser atlas={atlas()} selection={null} onSelect={() => undefined} />,
    );
    const main = within(container).getByTitle("svc/main.go");
    fireEvent.mouseEnter(main);
    const classes = arcs(container).map((arc) => arc.getAttribute("class"));
    expect(classes.some((one) => one?.includes("out") === true)).toBe(true);
    expect(classes.some((one) => one?.includes("in") === true && one.includes("refused"))).toBe(
      true,
    );
    expect(main.classList.contains("focus")).toBe(true);
    expect(within(container).getByTitle("svc/domain/repo.go").classList.contains("dep")).toBe(true);
    expect(within(container).getByTitle("svc/adapters/pg.go").classList.contains("importer")).toBe(
      true,
    );
    // Its node, `svc`, starts on line 2 of the manifest.
    expect(container.querySelector('li.line[data-line="2"]')?.classList.contains("own")).toBe(true);
    expect(container.querySelector('li.line[data-line="4"]')?.classList.contains("own")).toBe(
      false,
    );
  });

  it("lights the files a hovered manifest node governs", () => {
    const { container } = renderOpen(
      <ArchitectureBrowser atlas={atlas()} selection={null} onSelect={() => undefined} />,
    );
    const domainLine = container.querySelector('li.line[data-line="4"]');
    if (domainLine === null) throw new Error("no line 4");
    fireEvent.mouseEnter(domainLine);
    const rows = within(container);
    expect(rows.getByTitle("svc/domain/repo.go").classList.contains("governed")).toBe(true);
    expect(rows.getByTitle("svc/domain/model.go").classList.contains("governed")).toBe(true);
    expect(rows.getByTitle("svc/main.go").classList.contains("governed")).toBe(false);
    // The unused allowance is struck where it was written.
    expect(container.querySelector('li.line[data-line="5"]')?.classList.contains("slack")).toBe(
      false,
    );
  });

  it("does not scroll the manifest to a node hovered in the manifest", () => {
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    const { container } = renderOpen(
      <ArchitectureBrowser atlas={atlas()} selection={null} onSelect={() => undefined} />,
    );
    const domainLine = container.querySelector('li.line[data-line="5"]');
    if (domainLine === null) throw new Error("no line 5");
    fireEvent.mouseEnter(domainLine);
    expect(scrolled).not.toHaveBeenCalled();
    // A file hovered in the tree still brings its node into view.
    fireEvent.mouseLeave(container.querySelector(".manifest") as Element);
    fireEvent.mouseEnter(within(container).getByTitle("svc/domain/repo.go"));
    expect(scrolled).toHaveBeenCalled();
    scrolled.mockRestore();
  });

  it("marks each folder that declares a node, lit along the focus's chain", () => {
    const { container } = renderOpen(
      <ArchitectureBrowser atlas={atlas()} selection={null} onSelect={() => undefined} />,
    );
    const pills = () => [...container.querySelectorAll(".node-pill")];
    expect(pills().map((pill) => pill.textContent)).toEqual(["§", "§"]);
    fireEvent.mouseEnter(within(container).getByTitle("svc/domain/repo.go"));
    expect(pills().every((pill) => pill.classList.contains("chain"))).toBe(true);
    expect(container.querySelector(".tree")?.classList.contains("focused")).toBe(true);
  });

  it("marks a collapsed folder reached both ways by the files it hides", () => {
    // main.go imports domain/repo.go, and domain/model.go imports main.go.
    const both = {
      ...atlas(),
      edges: [...atlas().edges, edge("svc/domain/model.go", "svc/main.go")],
    };
    const { container } = render(
      <ArchitectureBrowser atlas={both} selection={null} onSelect={() => undefined} />,
    );
    fireEvent.mouseEnter(within(container).getByTitle("svc/main.go"));
    const domain = within(container).getByTitle("svc/domain");
    expect(domain.classList.contains("both")).toBe(true);
    expect(within(container).getByTitle("svc/adapters").classList.contains("importer")).toBe(true);
  });

  it("reports a click as the selection, and shows the detail for it", () => {
    const onSelect = vi.fn();
    const { container, rerender } = renderOpen(
      <ArchitectureBrowser atlas={atlas()} selection={null} onSelect={onSelect} />,
    );
    fireEvent.click(within(container).getByTitle("svc/adapters/pg.go"));
    expect(onSelect).toHaveBeenCalledWith("svc/adapters/pg.go");
    rerender(
      <ArchitectureBrowser atlas={atlas()} selection="svc/adapters/pg.go" onSelect={onSelect} />,
    );
    expect(within(container).getAllByText("[svc/adapters/imports] no").length).toBeGreaterThan(0);
    expect(within(container).getByText("unpin")).toBeTruthy();
  });
});
