import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { check, fingerprintsOf } from "../cli.js";
import {
  EVERY_FAMILY_ROOTS,
  everyFamilyFiles,
  everyFamilyFingerprints,
  everyFamilyManifest,
} from "../fixtures/every-family.js";
import { createRepo, type Repo } from "../repo.js";

// One planted violation per family, each with its expected fingerprint: the
// one place all six are proven through the bin.

let repo: Repo;

beforeAll(() => {
  repo = createRepo({ files: everyFamilyFiles });
  repo.writeManifest(everyFamilyManifest(repo.profile));
});

afterAll(() => {
  repo.dispose();
});

describe("every family fires", () => {
  it("reports exactly the planted violations, by fingerprint", () => {
    const result = check(repo, EVERY_FAMILY_ROOTS);

    expect(result.code).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.files).toBe(10);
    expect(result.json.unresolved).toEqual([]);
    expect(fingerprintsOf(result.json)).toEqual([...Object.values(everyFamilyFingerprints)].sort());
  });

  it("names each family once at least, and the graph three ways", () => {
    const { json } = check(repo, EVERY_FAMILY_ROOTS);
    const byKind = new Map<string, number>();
    for (const one of json.violations) byKind.set(one.kind, (byKind.get(one.kind) ?? 0) + 1);

    expect(Object.fromEntries(byKind)).toEqual({
      import: 1,
      export: 1,
      member: 2,
      surface: 1,
      structure: 2,
      graph: 3,
    });
    // The route a reach violation took is in the message, not the subject,
    // so the fingerprint survives the route changing.
    const reach = json.violations.find((one) => one.ruleName === "pure-reaches-no-adapter");
    expect(reach?.message).toContain("route: src/pure/calc.ts → src/adapters/db.ts");
  });
});
