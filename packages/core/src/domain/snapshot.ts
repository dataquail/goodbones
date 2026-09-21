import * as Schema from "effect/Schema";

import type { ViolationKind } from "./violation.js";

// The conformance snapshot: one JSON document per run saying how far the
// tree is from the manifest. `architecture conformance --json` emits it, a
// pull-request check compares two of them, an agent reads one before it
// edits, and a service that keeps history stores them — so it is a wire
// format, defined here with a schema before anything consumes it, and
// versioned so a document that grows it can say which one it grew.
//
// Three things it says that `check` does not: the residue (what no family
// reaches), the slack (what the allowlists permit and nothing uses), and the
// violations ordered by how much of the graph each fix drags along. Every
// entry that names a violation names it by its line-independent fingerprint,
// which is what lets one be tracked across commits.

export const SNAPSHOT_SCHEMA_ID =
  "https://dataquail.github.io/goodbones/schema/conformance.schema.json";

export const SNAPSHOT_VERSION = 2;

const describe = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description });

const COVERAGE_FAMILIES = ["imports", "structure", "members", "surface", "graph"] as const;

// The kinds `Violation` carries, spelled here as a schema; the `satisfies`
// below keeps the two lists one.
const VIOLATION_KINDS = [
  "import",
  "export",
  "structure",
  "member",
  "surface",
  "graph",
  "campaign",
] as const satisfies ReadonlyArray<ViolationKind>;

const Path = describe(Schema.String, "Repo-relative, with forward slashes.");

const FamilyCoverage = Schema.Struct({
  covered: describe(Schema.Finite, "Files this family reaches."),
  total: describe(Schema.Finite, "Files walked."),
  floor: Schema.optionalKey(
    describe(
      Schema.Finite,
      "The fraction the manifest's `limits.coverage` states for this family, when it states one.",
    ),
  ),
});

export const CONFORMANCE_MEASURES = ["residue", "vacant", "slack", "concentration"] as const;

export type ConformanceMeasure = (typeof CONFORMANCE_MEASURES)[number];

// One conformance measure as `check` holds it: the count, and the ceiling
// the manifest's `limits.conformance` states for it, when it states one.
const MeasureCount = Schema.Struct({
  count: describe(Schema.Finite, "What the measure counts today."),
  ceiling: Schema.optionalKey(
    describe(
      Schema.Finite,
      "The count the manifest's `limits.conformance` states for this measure, when it states one.",
    ),
  ),
});

export const SnapshotViolation = Schema.Struct({
  fingerprint: describe(
    Schema.String,
    "kind|rule|file|subject — line-independent, so it survives edits to the file it names; the baseline's key.",
  ),
  kind: Schema.Literals(VIOLATION_KINDS),
  ruleName: describe(Schema.String, "The manifest node path the rule was lowered from."),
  file: Path,
  subject: describe(
    Schema.NullOr(Schema.String),
    "The other end of the violated relationship — the resolved target, the restricted symbol, the missing sibling — or null when the file alone is the violation.",
  ),
  message: Schema.String,
  baselined: describe(Schema.Boolean, "Carried by the baseline, so `check` does not fail on it."),
  ledgered: describe(
    Schema.Boolean,
    "For a campaign hit: carried by the objective's ledger, so `check` does not fail on it.",
  ),
  objective: Schema.optionalKey(
    describe(Schema.String, "For a campaign hit: the objective that fired."),
  ),
  sector: Schema.optionalKey(
    describe(Schema.String, "For a campaign hit: the sector the hit falls in."),
  ),
  entry: Schema.optionalKey(
    describe(Schema.String, "For a campaign hit: its ledger entry, relative to the sector's root."),
  ),
});

const AllowanceKind = describe(
  Schema.Literals(["allow", "external"]),
  "`allow` is a path glob under `imports.allow`; `external` a package name under `imports.external`.",
);

const Entry = describe(Schema.String, "The entry as written, after alias expansion.");

export const SnapshotSlack = Schema.Struct({
  node: describe(
    Schema.String,
    "The manifest node that wrote the entry — or, when `fragment` is set, the `defs` fragment it was written in.",
  ),
  kind: AllowanceKind,
  entry: Entry,
  fragment: Schema.optionalKey(
    describe(
      Schema.String,
      "Present when the entry arrived through `use`. The nodes that referenced the fragment wrote one word, so the entry is reported once, against the fragment, rather than once per node.",
    ),
  ),
  of: Schema.optionalKey(
    describe(
      Schema.Finite,
      "With `fragment`: how many non-vacant nodes were granted the entry through it. None of them uses it.",
    ),
  ),
});

export const SnapshotConcentration = Schema.Struct({
  fragment: describe(Schema.String, "The `defs` fragment the entry was written in."),
  kind: AllowanceKind,
  entry: Entry,
  usedAt: describe(Schema.Finite, "Nodes granted the entry through the fragment that use it."),
  of: describe(Schema.Finite, "Non-vacant nodes granted the entry through the fragment."),
});

export const SnapshotVacancy = Schema.Struct({
  node: describe(Schema.String, "The manifest node."),
  allowances: describe(
    Schema.Finite,
    "Distinct entries the node wrote, `allow` and `external` together.",
  ),
});

// One objective's burn-down: what its ledger says, summed over its sectors.
export const SnapshotObjective = Schema.Struct({
  id: describe(
    Schema.String,
    "The objective's id; its ledger is `<ledger>/<campaign>/<objective>.json`.",
  ),
  phase: describe(
    Schema.NullOr(Schema.String),
    "The phase naming the objective, or `null` for one no phase names — in window everywhere.",
  ),
  initial: describe(Schema.Finite, "Holdouts recorded as each sector entered the window, summed."),
  allowed: describe(
    Schema.Finite,
    "Holdouts added since by `objectives concede` or a re-baseline, each with a concession.",
  ),
  count: describe(Schema.Finite, "Holdouts in the ledger now, every sector summed."),
  cleared: describe(
    Schema.Finite,
    "Holdouts removed by `objectives clear` because they stopped firing.",
  ),
  closed: describe(
    Schema.Finite,
    "Holdouts still firing when a sector left the window — not progress.",
  ),
  progress: describe(
    Schema.Finite,
    "`1 - count / (initial + allowed - closed)`: how much of everything ever ledgered has been paid down.",
  ),
  lastCleared: describe(
    Schema.NullOr(Schema.String),
    "When a holdout last left the ledger, ISO 8601 — the stall clock's reading; `null` with no ledger.",
  ),
  concessions: describe(Schema.Finite, "How many times a count was allowed to go up."),
  complete: describe(Schema.Boolean, "No holdouts remain."),
  ledgered: describe(
    Schema.Boolean,
    "Whether a ledger exists. An objective with none has been declared and not yet cleared.",
  ),
});

// One phase of the ladder, and how many sectors stand at it.
export const SnapshotPhase = Schema.Struct({
  id: describe(Schema.String, "The phase's id."),
  defined: describe(
    Schema.Boolean,
    "Whether the phase names criteria. An open phase has only an intent, and is last.",
  ),
  sectors: describe(Schema.Finite, "How many sectors are derived to stand at this phase."),
});

// One sector: where it stands, and its residue toward its next phase.
export const SnapshotSector = Schema.Struct({
  name: describe(Schema.String, "The sector's identity, as its perimeter names it."),
  phase: describe(
    Schema.NullOr(Schema.String),
    "The phase the sector is derived to stand at, or `null` when it is past the last one.",
  ),
  reached: describe(
    Schema.NullOr(Schema.String),
    "The furthest phase the sector's record says it has reached; `null` before its first `clear`.",
  ),
  files: describe(Schema.Finite, "How many files the sector claims."),
  residue: describe(
    Schema.Record(Schema.String, Schema.Finite),
    "One dimension per objective in window for the sector: its holdouts there, never summed.",
  ),
  stalled: describe(
    Schema.Boolean,
    "Holdouts remain for the sector and nothing has been cleared, attested or noted within `staleAfter`.",
  ),
});

// One campaign: its objectives' burn-down, the distribution of its sectors
// over its phases, the legacy remainder, and what changed in its plan.
export const SnapshotCampaign = Schema.Struct({
  id: describe(Schema.String, "The campaign's id; its ledgers are under `<ledger>/<id>/`."),
  title: Schema.optionalKey(describe(Schema.String, "The campaign's title, when it states one.")),
  owner: Schema.optionalKey(
    describe(Schema.String, "Who is running the campaign, as the manifest names them."),
  ),
  count: describe(Schema.Finite, "Holdouts across every objective and sector."),
  progress: describe(
    Schema.Finite,
    "Cleared over everything ever ledgered, across the campaign's objectives.",
  ),
  objectives: describe(Schema.Array(SnapshotObjective), "Every objective, in manifest order."),
  phases: describe(
    Schema.Array(SnapshotPhase),
    "The ladder, in order, with how many sectors stand at each phase.",
  ),
  sectors: describe(Schema.Array(SnapshotSector), "Every sector the perimeter births, by name."),
  legacy: describe(
    Schema.Struct({
      files: describe(Schema.Finite, "Files in the scope no sector claims."),
      holdouts: describe(
        Schema.Finite,
        "Holdouts in the legacy, under the first phase's objectives — where a holdout moved out of a sector lands.",
      ),
    }),
    "The unclaimed remainder of the scope, which stands at the first phase and is not a sink.",
  ),
  plan: describe(
    Schema.Struct({
      refined: describe(
        Schema.Array(Schema.String),
        "Phases refined since the last `clear`: an open phase that gained criteria, or a new one. Free.",
      ),
      changed: describe(
        Schema.Array(Schema.String),
        "Defined phases whose definition changed since the last `clear` — what a reviewer reads every time.",
      ),
      unreceipted: describe(
        Schema.Array(Schema.String),
        "Changed phases carrying no new concession; `check` fails on them.",
      ),
    }),
    "What changed in the plan, refinements and changes apart.",
  ),
  stalled: describe(
    Schema.Boolean,
    "Holdouts remain and nothing has been cleared, attested or noted within the campaign's `staleAfter`.",
  ),
  complete: describe(Schema.Boolean, "No holdouts remain in any objective."),
  onComplete: describe(
    Schema.Literals(["keep", "remove"]),
    "What the manifest asks once complete: keep the campaign as a guard, or remove it.",
  ),
  ledgered: describe(Schema.Boolean, "Whether every objective has a ledger."),
});

export const Snapshot = Schema.Struct({
  version: describe(Schema.Literal(SNAPSHOT_VERSION), "The shape of this document."),
  manifest: describe(
    Schema.Struct({
      path: describe(
        Path,
        "The file the policy was read from — the root file, when split with `include`.",
      ),
      sha256: describe(
        Schema.String,
        "A hash of that file's bytes, so two snapshots can say whether the policy changed between them.",
      ),
    }),
    "The policy this snapshot was taken against — the repository's own, or the one `--against` named.",
  ),
  roots: describe(Schema.Array(Path), "The directories walked."),
  files: describe(Schema.Finite, "Files walked."),
  ok: describe(
    Schema.Boolean,
    "What `check` would exit with: true when no reportable violation, unresolved import, stale baseline entry or coverage shortfall exists.",
  ),
  coverage: describe(
    Schema.Struct(
      Object.fromEntries(COVERAGE_FAMILIES.map((family) => [family, FamilyCoverage])) as Record<
        (typeof COVERAGE_FAMILIES)[number],
        typeof FamilyCoverage
      >,
    ),
    "Per family, how many walked files it reaches. Structure counts enumerated folders only.",
  ),
  conformance: describe(
    Schema.Struct(
      Object.fromEntries(CONFORMANCE_MEASURES.map((measure) => [measure, MeasureCount])) as Record<
        ConformanceMeasure,
        typeof MeasureCount
      >,
    ),
    "Per measure, the count `check` holds to the manifest's `limits.conformance`: residue files, vacant nodes, slack allowances, and fragment entries used at fewer than half the nodes granted them. The lists below name what each counts.",
  ),
  residue: describe(
    Schema.Struct({
      files: describe(Schema.Array(Path), "Files no family reaches, sorted."),
      folders: describe(
        Schema.Array(Path),
        "Folders every walked file of which is residue, each the topmost such folder.",
      ),
    }),
    "What the policy has nothing to say about. A file in an open folder under no allowlist is claimed, not policed, and counts.",
  ),
  vacant: describe(
    Schema.Array(SnapshotVacancy),
    "Nodes that state an import allowlist and select no walked file, in manifest order. Every allowance on one is unused by construction, so none is counted as slack; the node is a tier declared ahead of its first file, or a pattern that no longer matches. Residue is files no node reaches; this is nodes no file reaches.",
  ),
  violations: describe(
    Schema.Array(SnapshotViolation),
    "Every finding, baselined ones included, ordered so the ones cheapest to fix come first: by the height of the violated target in the import graph, leaves first.",
  ),
  unresolved: describe(
    Schema.Array(Schema.Struct({ file: Path, specifier: Schema.String, detail: Schema.String })),
    "Imports the resolver could not turn into a file. Every rule about one enforces nothing.",
  ),
  stale: describe(Schema.Array(Schema.String), "Baseline entries the code no longer produces."),
  baseline: describe(
    Schema.Struct({
      size: describe(Schema.Finite, "Entries in the baseline file."),
    }),
    "The debt the policy is carrying. The ratchet: it may only shrink.",
  ),
  cycles: describe(
    Schema.Finite,
    "Strongly connected components of more than one file, or a file importing itself, anywhere in the walked graph — in a cycles rule's scope or not.",
  ),
  slack: describe(
    Schema.Array(SnapshotSlack),
    "Allowances no observed import uses, in manifest order, vacant nodes excluded. A manifest inferred from the tree has none on the day it is written; every entry here is permission nothing needs. An entry that arrived through `use` is reported once, against the fragment, and only when no node granted it uses it.",
  ),
  concentration: describe(
    Schema.Array(SnapshotConcentration),
    "Fragment entries used at some of the nodes granted them and not the rest. Not slack — the fragment's line is needed somewhere — but a per-file permission written as a many-node allowance, which is what an allowlist widened to make one build green looks like.",
  ),
  adoption: describe(
    Schema.Struct({
      unrestricted: describe(Schema.Array(Schema.String), "Nodes that say `unrestricted: true`."),
      partial: describe(Schema.Array(Schema.String), "Nodes that say `partial: true`."),
    }),
    'The tiers that said "not tightened yet", by name; `limits` caps how many may.',
  ),
  campaigns: describe(
    Schema.Array(SnapshotCampaign),
    "Every campaign the manifest declares, in manifest order, with its burn-down. Campaign hits are not counted in `coverage` or `residue`: a campaign is scoped by construction.",
  ),
});

export type Snapshot = typeof Snapshot.Type;
export type SnapshotViolation = typeof SnapshotViolation.Type;
export type SnapshotSlack = typeof SnapshotSlack.Type;
export type SnapshotConcentration = typeof SnapshotConcentration.Type;
export type SnapshotVacancy = typeof SnapshotVacancy.Type;
export type SnapshotCampaign = typeof SnapshotCampaign.Type;
export type SnapshotObjective = typeof SnapshotObjective.Type;
export type SnapshotPhase = typeof SnapshotPhase.Type;
export type SnapshotSector = typeof SnapshotSector.Type;

// Decodes a document some other run wrote — the base of a pull request, a
// stored one — refusing a key the shape does not declare, so a consumer never
// reads a field that a later version renamed.
export const decodeSnapshot = Schema.decodeUnknownResult(Snapshot, {
  errors: "all",
  onExcessProperty: "error",
});

type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
type JsonObject = { readonly [key: string]: JsonValue };

// The document's shape as a JSON Schema, generated from the same codec, so
// the two cannot disagree. Published beside the manifest's.
export const snapshotJsonSchema = (): JsonObject => {
  const generated = Schema.toJsonSchemaDocument(Snapshot) as unknown as {
    readonly schema: JsonObject;
    readonly definitions: JsonObject;
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SNAPSHOT_SCHEMA_ID,
    title: "Conformance snapshot",
    description:
      "How far a repository's tree is from its architecture manifest, as `architecture conformance --json` reports it. See https://dataquail.github.io/goodbones/architecture-rules/enforcement/conformance/.",
    ...generated.schema,
    ...(Object.keys(generated.definitions).length === 0 ? {} : { $defs: generated.definitions }),
  };
};
