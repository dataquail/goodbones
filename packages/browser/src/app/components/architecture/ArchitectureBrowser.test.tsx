// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArchitectureBrowser } from "./ArchitectureBrowser.js";
import { atlas } from "./fixture.test-helper.js";

// The browser under a pointer: hovering a file brings its edges forward and
// lights the node that governs it in the manifest; hovering a manifest line
// lights the files its node governs; a click keeps either and reports it.

afterEach(cleanup);

// jsdom lays nothing out, so it has no scrolling to do.
Element.prototype.scrollIntoView = () => undefined;

const arcs = (container: HTMLElement) => [
  ...container.querySelectorAll<SVGPathElement>("path.arc"),
];

describe.sequential("ArchitectureBrowser", () => {
  it("draws every row and every arc, greyed", () => {
    const { container } = render(
      <ArchitectureBrowser atlas={atlas()} selection={null} onSelect={() => undefined} />,
    );
    expect(container.querySelectorAll("li.row")).toHaveLength(7);
    expect(arcs(container)).toHaveLength(3);
    expect(arcs(container).every((arc) => arc.classList.contains("dim"))).toBe(true);
    expect(container.querySelectorAll("li.line")).toHaveLength(6);
  });

  it("brings a hovered file's edges forward and lights its node in the manifest", () => {
    const { container } = render(
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
    const { container } = render(
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

  it("reports a click as the selection, and shows the detail for it", () => {
    const onSelect = vi.fn();
    const { container, rerender } = render(
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
