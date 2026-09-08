import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.js";
import type { CanvasProps } from "./canvas.js";
import { FIXTURE } from "./fixture.test.js";
import { gridLayout } from "./layout.js";

// The canvas needs a real layout engine and a browser's measurements; here
// it is a list of what it would draw, so the app around it — the crumbs, the
// toggles, the panel, the hash — is what these tests are about.
vi.mock("./canvas.js", () => ({
  Canvas: (props: CanvasProps) => (
    <ul data-testid="canvas">
      {props.view.members.map((member) => (
        <li key={member.id}>
          <button
            type="button"
            onClick={() => {
              props.onNode(member);
            }}
          >
            {member.label}
          </button>
        </li>
      ))}
      {props.view.edges.map((edge) => (
        <li key={`${edge.from}|${edge.to}`}>
          <button
            type="button"
            onClick={() => {
              props.onEdge(edge);
            }}
          >
            {edge.from} → {edge.to} ({edge.status})
          </button>
        </li>
      ))}
    </ul>
  ),
}));

const serving = (body: unknown) => () =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe.sequential("the explorer", () => {
  it("loads the atlas, draws the focus, and drills into a folder through the hash", async () => {
    window.location.hash = "#focus=src";
    render(<App fetcher={serving(FIXTURE)} layout={gridLayout} />);
    await waitFor(() => {
      expect(screen.getByTestId("canvas")).toBeTruthy();
    });
    expect(screen.getByText("app/")).toBeTruthy();
    expect(screen.getByText("domain/")).toBeTruthy();
    expect(screen.getByText("src/domain → pkg:effect (violation)")).toBeTruthy();

    fireEvent.click(screen.getByText("domain/"));
    await waitFor(() => {
      expect(window.location.hash).toBe("#focus=src%2Fdomain");
    });
    expect(screen.getByText("order.ts")).toBeTruthy();
    // The crumb bar names the way up, and takes it.
    fireEvent.click(screen.getByRole("button", { name: "src" }));
    await waitFor(() => {
      expect(window.location.hash).toBe("#focus=src");
    });
  });

  it("explains a selected edge in the manifest's own words", async () => {
    window.location.hash = "#focus=src";
    render(<App fetcher={serving(FIXTURE)} layout={gridLayout} />);
    await waitFor(() => {
      expect(screen.getByTestId("canvas")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("src/domain → pkg:effect (violation)"));
    await waitFor(() => {
      expect(window.location.hash).toContain("select=edge");
    });
    // Once as the edge's worst violation, once on the import beneath it.
    expect(screen.getAllByText("domain/ reaches only itself.").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        "import|src/domain/imports|src/domain/order.ts|node_modules/effect/index.js",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("offers a rescan only when a server is there", async () => {
    render(<App fetcher={serving(FIXTURE)} layout={gridLayout} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "rescan" })).toBeTruthy();
    });
    cleanup();
    render(<App fetcher={serving(FIXTURE)} layout={gridLayout} inline={JSON.stringify(FIXTURE)} />);
    await waitFor(() => {
      expect(screen.getByTestId("canvas")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "rescan" })).toBeNull();
  });

  it("says when the atlas cannot be read", async () => {
    render(<App fetcher={serving({ version: 2 })} layout={gridLayout} />);
    await waitFor(() => {
      expect(screen.getByText("could not load the atlas")).toBeTruthy();
    });
  });
});
