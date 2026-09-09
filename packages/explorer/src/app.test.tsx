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

// A server with the atlas and nothing else: a file's facts are unavailable.
const serving = (body: unknown) => (url: string) =>
  Promise.resolve({ ok: url === "atlas.json", json: () => Promise.resolve(body) });

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
    await waitFor(() => {
      expect(screen.getByText("order.ts")).toBeTruthy();
    });
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

  it("finds a file by path and opens its folder with the file selected", async () => {
    render(<App fetcher={serving(FIXTURE)} layout={gridLayout} />);
    await waitFor(() => {
      expect(screen.getByTestId("canvas")).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("find a file by path"), { target: { value: "order" } });
    fireEvent.click(screen.getByRole("option", { name: "src/domain/order.ts" }));
    await waitFor(() => {
      expect(window.location.hash).toBe(
        "#focus=src%2Fdomain&select=node%3Asrc%2Fdomain%2Forder.ts",
      );
    });
    // The panel explains the file: its tier, the violation on it, and that
    // this server has no facts to give.
    await waitFor(() => {
      expect(screen.getByText("domain/ is the model.")).toBeTruthy();
    });
    expect(screen.getAllByText("domain/ reaches only itself.").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getByText("the server could not read this file's facts")).toBeTruthy();
    });
  });

  it("traces a selected violation, and lights a selected cycle", async () => {
    const cyclic = {
      ...FIXTURE,
      cycles: [["src/domain/order.ts", "src/domain/user.ts"]],
    };
    window.location.hash =
      "#focus=src%2Fdomain&select=violation%3Aimport%7Csrc%2Fdomain%2Fimports%7Csrc%2Fdomain%2Forder.ts%7Cnode_modules%2Feffect%2Findex.js";
    render(<App fetcher={serving(cyclic)} layout={gridLayout} />);
    await waitFor(() => {
      expect(screen.getByTestId("canvas")).toBeTruthy();
    });
    expect(screen.getByRole("heading", { name: /src\/domain\/imports/ })).toBeTruthy();
    expect(screen.getByText("← clear selection")).toBeTruthy();

    fireEvent.click(screen.getByText("← clear selection"));
    await waitFor(() => {
      expect(window.location.hash).toBe("#focus=src%2Fdomain");
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /↻ 2 files/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /↻ 2 files/ }));
    await waitFor(() => {
      expect(window.location.hash).toBe("#focus=src%2Fdomain&select=cycle%3A0");
    });
    await waitFor(() => {
      expect(screen.getByText("cycle of 2 files")).toBeTruthy();
    });
  });

  it("copies the view as mermaid, as diagram would print it", async () => {
    const copied: Array<string> = [];
    window.location.hash = "#focus=src&inside";
    render(
      <App
        fetcher={serving(FIXTURE)}
        layout={gridLayout}
        copy={(text) => {
          copied.push(text);
          return Promise.resolve();
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("canvas")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "copy mermaid" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "copied" })).toBeTruthy();
    });
    expect(copied).toEqual([
      `flowchart TB
  n_src_app["app/"]
  n_src_domain["domain/ ⚠ 1"]
  n_src_app --> n_src_domain
`,
    ]);
  });

  it("says when the atlas cannot be read", async () => {
    render(<App fetcher={serving({ version: 2 })} layout={gridLayout} />);
    await waitFor(() => {
      expect(screen.getByText("could not load the atlas")).toBeTruthy();
    });
  });
});
