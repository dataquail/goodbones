import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { ManifestLocator } from "../domain/manifest-location.js";
import { decodeManifest } from "./manifest.js";

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error("expected a failure");
  return result.failure;
};

const VALID = {
  resolve: { scopes: [{ files: "", language: "typescript" }] },
  tree: { "src/": { children: {}, members: [{ message: "m", subject: "calls" }] } },
};

// A locator that answers with a line made from the path, so a test can see
// which path the decoder asked about.
const locate: ManifestLocator = (path) => ({ line: path.length, column: 1 });

describe("decodeManifest", () => {
  it("decodes a valid manifest", () => {
    expect(Result.isSuccess(decodeManifest("architecture.yaml", VALID))).toBe(true);
  });

  it("refuses a key the schema does not declare, rather than dropping it", () => {
    const detail = failure(
      decodeManifest("architecture.yaml", {
        ...VALID,
        tree: {
          "src/": { children: {}, members: [{ message: "m", subject: "calls", matchNott: "x" }] },
        },
      }),
    ).detail;
    expect(detail).toMatch(/tree\["src\/"\]\.members\[0\]\.matchNott: Unexpected key/);
  });

  it("reports every issue, each with its path", () => {
    const detail = failure(
      decodeManifest("architecture.yaml", {
        ...VALID,
        tree: {
          "src/": {
            children: {},
            members: [{ message: "m", subject: "call" }],
            imports: { allow: 3 },
          },
        },
      }),
    ).detail;
    expect(detail).toMatch(/members\[0\]\.subject: Expected "members" \| "calls"/);
    expect(detail).toMatch(/imports\.allow: Expected string \| array/);
  });

  it("names the file, line and column when the reader can locate a path", () => {
    const error = failure(
      decodeManifest(
        "/repo/architecture.yaml",
        { ...VALID, tree: { "src/": { children: {}, layout: "closed" } } },
        { locate },
      ),
    );
    expect(error.detail).toContain('  architecture.yaml:3:1  tree["src/"].layout: Expected "open"');
    expect(error.message).toMatch(/^\/repo\/architecture\.yaml: the manifest does not decode:/);
  });

  it("names the file a position carries, for a value the manifest included", () => {
    const acrossFiles: ManifestLocator = (path) =>
      path[1] === "src/"
        ? { line: path.length, column: 1, file: "packages/src/architecture.yaml" }
        : { line: path.length, column: 1 };
    const detail = failure(
      decodeManifest(
        "/repo/architecture.yaml",
        { ...VALID, tree: { "src/": { children: {}, layout: "closed" } } },
        { locate: acrossFiles },
      ),
    ).detail;
    expect(detail).toContain(
      '  packages/src/architecture.yaml:3:1  tree["src/"].layout: Expected "open"',
    );
  });

  it("reports an issue inside a fragment at the fragment, via the use that pulled it in", () => {
    const detail = failure(
      decodeManifest(
        "architecture.yaml",
        {
          ...VALID,
          defs: { rule: { message: "m", subject: "call" } },
          tree: { "src/": { children: {}, members: [{ use: "rule" }] } },
        },
        { locate },
      ),
    ).detail;
    expect(detail).toContain(
      'architecture.yaml:3:1  defs.rule.subject: Expected "members" | "calls", got "call" (via `use: "rule"` at architecture.yaml:4:1)',
    );
  });

  it("reports an override at the site that wrote it", () => {
    const detail = failure(
      decodeManifest("architecture.yaml", {
        ...VALID,
        defs: { rule: { message: "m", subject: "calls" } },
        tree: { "src/": { children: {}, members: [{ use: "rule", subject: "call" }] } },
      }),
    ).detail;
    expect(detail).toMatch(/tree\["src\/"\]\.members\[0\]\.subject: Expected/);
    expect(detail).not.toMatch(/via/);
  });

  it("reports an expansion failure with its own heading", () => {
    const error = failure(
      decodeManifest(
        "architecture.yaml",
        { ...VALID, tree: { "src/": { use: "nope" } } },
        { locate },
      ),
    );
    expect(error.detail).toMatch(
      /does not expand:\n {2}architecture\.yaml:2:1 {2}tree\["src\/"\]: `use: "nope"`/,
    );
  });

  it("strips a $schema key and honours defs in any format", () => {
    const decoded = decodeManifest("architecture.json", {
      $schema: "https://example.invalid/schema.json",
      defs: { rule: { message: "m", subject: "calls" } },
      ...VALID,
      tree: { "src/": { children: {}, members: [{ use: "rule" }] } },
    });
    expect(Result.isSuccess(decoded)).toBe(true);
  });
});
