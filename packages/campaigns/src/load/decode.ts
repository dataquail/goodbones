import type { ManifestPath } from "@goodbones/core";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import { CampaignsManifest } from "../manifest/spec.js";

// Decoding this family's slice of the manifest. The core has already expanded
// `defs`/`use` and `include` and split these keys off; what arrives here is
// `{ campaigns?, ledger? }` as written.
//
// Every issue, not the first, and each rendered through the `describe` the
// core handed over — so a campaign's decode error carries the same line,
// path and `use` trail a tree node's does.

export { CampaignsManifest } from "../manifest/spec.js";
export { DEFAULT_LEDGER_DIR } from "../manifest/spec.js";

const decode = Schema.decodeUnknownResult(CampaignsManifest, {
  errors: "all",
  onExcessProperty: "error",
});
const flatten = SchemaIssue.makeFormatterStandardSchemaV1();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isList = (value: unknown): value is ReadonlyArray<unknown> => Array.isArray(value);

// The standard-schema formatter flattens the issue tree to `{ path, message }`
// pairs; a path segment may arrive wrapped as `{ key }`.
const pathOf = (issue: {
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}): ManifestPath =>
  (issue.path ?? []).map((segment) => (typeof segment === "object" ? segment.key : segment));

// The family's first shape — a list of campaigns each carrying one `detect` —
// is refused by name, since the decoder's own message for it would be a wall
// of union issues. A campaign now owns its `objectives`, each of which is
// what a campaign used to be.
const legacyCampaignsIssue = (campaigns: unknown): string | null => {
  if (campaigns === undefined) return null;
  if (isList(campaigns)) {
    return (
      "`campaigns` is a list. A campaign is now a map keyed by its id, and what a campaign used " +
      "to be — a detector with a ledger — is one of its `objectives`: write " +
      "`campaigns: { <id>: { objectives: { <objective>: { holdout, match, probes } } } }`, " +
      "with `unit` renamed `holdout` and `detect` renamed `match`."
    );
  }
  if (!isRecord(campaigns)) return null;
  for (const [id, campaign] of Object.entries(campaigns)) {
    if (!isRecord(campaign)) continue;
    if ("detect" in campaign && !("objectives" in campaign)) {
      return (
        `campaign "${id}" carries a \`detect\` and no \`objectives\`. A campaign owns its ` +
        `objectives, each a detector with a ledger: move \`detect\` (now \`match\`), \`unit\` ` +
        `(now \`holdout\`) and \`probes\` under \`objectives: { <objective>: … }\`.`
      );
    }
  }
  return null;
};

export const decodeCampaigns = (
  slice: Readonly<Record<string, unknown>>,
  describe: (path: ManifestPath, detail: string) => string,
): Result.Result<CampaignsManifest, ReadonlyArray<string>> => {
  const legacy = legacyCampaignsIssue(slice.campaigns);
  if (legacy !== null) return Result.fail([describe(["campaigns"], legacy)]);

  const decoded = decode(slice);
  if (Result.isFailure(decoded)) {
    return Result.fail(
      flatten(decoded.failure.issue).issues.map((issue) =>
        describe(pathOf(issue), issue.message),
      ),
    );
  }
  return Result.succeed(decoded.success);
};
