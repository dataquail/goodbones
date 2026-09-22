import {
  anchored,
  CONVENTIONS,
  decodeManifestTree,
  expandAliases,
  globsOf,
  globToRegexSource,
  type LoweredRules,
  lowerManifest,
  type Manifest,
  prefixed,
  type ProbeLanguage,
} from "@goodbones/core";
import * as Result from "effect/Result";

import type {
  CampaignProbe,
  CampaignRule,
  Detector,
  ObjectiveRule,
  PerimeterRule,
  PhaseRule,
  SectorTerm,
} from "../domain/config.js";
import {
  type CampaignProbesSpec,
  type CampaignsManifest,
  type CampaignSpec,
  type DetectorSpec,
  durationMs,
  type PhaseSpec,
  type SyntaxTermSpec,
} from "./spec.js";

// The campaigns family's lowering: what a reader wrote under `campaigns`,
// with its globs resolved the way every other family's are, its phases
// checked for the shapes the design refuses, and an `endState` expanded into
// one synthetic objective per family.
//
// It reaches into @goodbones/core for the glob primitives the core's own
// lowering uses — `globToRegexSource`, `anchored`, `prefixed`, `expandAliases`
// and the naming `CONVENTIONS` — because a campaign's `scope` must resolve to
// exactly the pattern an `imports` rule's would. Writing a second glob
// compiler here is how the two would drift.

// The keys of a `syntax` term that belong to the engine's rule; `where` is
// the one that does not.
const SYNTAX_RULE_KEYS = [
  "pattern",
  "kind",
  "regex",
  "nthChild",
  "inside",
  "has",
  "precedes",
  "follows",
  "all",
  "any",
  "not",
] as const;

const syntaxRuleOf = (term: SyntaxTermSpec): unknown =>
  Object.fromEntries(
    SYNTAX_RULE_KEYS.flatMap((key) => (term[key] === undefined ? [] : [[key, term[key]]])),
  );

// The leaf terms a path alone cannot exercise: each reads the file's text,
// its syntax, or its facts, so a probe for a detector holding one must carry
// a `source`.
const TERMS_NEEDING_SOURCE = ["content", "syntax", "exports", "members", "fn"] as const;

const leafTermsOf = (detector: DetectorSpec): ReadonlyArray<string> => {
  if ("all" in detector) return detector.all.flatMap(leafTermsOf);
  if ("any" in detector) return detector.any.flatMap(leafTermsOf);
  if ("not" in detector) return leafTermsOf(detector.not);
  return Object.keys(detector);
};

// The families an `endState` tree can expand into — one synthetic objective
// per family the lowered tree actually produces rules for.
const END_STATE_FAMILIES = ["imports", "exports", "members", "surface", "structure"] as const;
type EndStateFamily = (typeof END_STATE_FAMILIES)[number];

// The id a family's synthetic objective carries, `end-state-<family>`, and
// its ledger file's name.
export const endStateObjectiveId = (family: EndStateFamily): string => `end-state-${family}`;

// The abstract root an `endState` is compiled and probed at, once, before
// any sector exists to lower it for.
export const END_STATE_ROOT = "~";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A sector-relative tree lowered for one sector: every `~/` becomes the
// sector's root, and an allow entry `{ sector, via }` — another sector,
// through its port — becomes that sector's `via` path for each sector the
// name selects. The result is an ordinary manifest fragment, lowered by the
// same pass as the repository's own tree.
export const lowerEndState = (
  tree: Readonly<Record<string, unknown>>,
  root: string,
  sectors: ReadonlyArray<{ readonly name: string; readonly root: string }>,
  resolve: Manifest["resolve"],
  languages: ReadonlyArray<ProbeLanguage>,
  aliases: Readonly<Record<string, string>> = {},
): LoweredRules => {
  const rebase = (glob: string): string =>
    glob === "~" || glob === "~/"
      ? `${root}/`
      : glob.startsWith("~/")
        ? `${root}/${glob.slice(2)}`
        : glob;
  const walk = (value: unknown, key: string): unknown => {
    if (Array.isArray(value)) {
      return value.flatMap((item: unknown) => {
        if (key === "allow" && isRecord(item) && typeof item.via === "string") {
          const named = item.sector;
          // `~/ports/` names a folder: everything under it.
          const via = (item.via.startsWith("~/") ? item.via.slice(2) : String(item.via)).replace(
            /\/$/,
            "/**",
          );
          return sectors
            .filter((one) => named === "*" || named === undefined || one.name === named)
            .filter((one) => one.root !== root)
            .map((one) => `${one.root}/${via}`);
        }
        return [walk(item, key)];
      });
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, child]) => [
          key === "children" || key === "" ? rebaseKey(childKey) : childKey,
          walk(child, childKey),
        ]),
      );
    }
    return typeof value === "string" ? rebase(value) : value;
  };
  const rebaseKey = (key: string): string => (key === "~/" ? `${root}/` : key);
  const rebased = decodeManifestTree(walk(tree, ""));
  if (Result.isFailure(rebased)) {
    throw new Error(`the endState does not decode as a tree:\n${rebased.failure}`);
  }
  const manifest: Manifest = { resolve, aliases, tree: rebased.success };
  return lowerManifest(manifest, languages, {});
};

// Which families a tree yields at all, decided once at the abstract root.
const endStateFamiliesOf = (
  tree: Readonly<Record<string, unknown>>,
  resolve: Manifest["resolve"],
  languages: ReadonlyArray<ProbeLanguage>,
): ReadonlyArray<EndStateFamily> => {
  const lowered = lowerEndState(tree, END_STATE_ROOT, [], resolve, languages);
  const structure =
    lowered.structure.roots.length +
    lowered.structure.folders.length +
    lowered.structure.parity.length +
    lowered.structure.naming.length;
  return END_STATE_FAMILIES.filter((family) =>
    family === "structure" ? structure > 0 : lowered[family].length > 0,
  );
};

// A stable digest of a phase's definition — its position, its objectives
// and their detectors — so a change to a defined phase is visible against
// what the plan file recorded. FNV-1a over the canonical JSON.
const digest = (value: unknown): string => {
  const canonical = (one: unknown): unknown =>
    Array.isArray(one)
      ? one.map(canonical)
      : isRecord(one)
        ? Object.fromEntries(
            Object.keys(one)
              .sort()
              .map((key) => [key, canonical(one[key])]),
          )
        : one;
  const text = JSON.stringify(canonical(value));
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

// A campaign lowered: its globs resolved — `scope`, `legacy`, a perimeter's
// glob or marker, and inside each objective a path-shaped `resolves` the way
// graph rules resolve theirs, `exports`/`members` names the way `surface`
// and `members` rules do, the rest carried as written — its phases checked
// for the shapes the design refuses, and an `endState` expanded into one
// synthetic objective per family. The `fn` string is kept verbatim for the
// loader, which holds the function it names.
const lowerCampaign = (
  id: string,
  campaign: CampaignSpec,
  aliases: Readonly<Record<string, string>>,
  resolve: Manifest["resolve"],
  languages: ReadonlyArray<ProbeLanguage>,
): CampaignRule => {
  const asPath = (glob: string): string =>
    prefixed(
      globToRegexSource(expandAliases(glob, aliases), {}, { declaring: false, nextGroup: 1 })
        .source,
    );
  const asName = (globs: string | ReadonlyArray<string>): ReadonlyArray<string> =>
    globsOf(globs).map((one) =>
      anchored(globToRegexSource(one, {}, { declaring: false, nextGroup: 1 }).source),
    );
  const asWhole = (globs: string | ReadonlyArray<string>): ReadonlyArray<string> =>
    globsOf(globs).map((one) =>
      anchored(
        globToRegexSource(expandAliases(one, aliases), {}, { declaring: false, nextGroup: 1 })
          .source,
      ),
    );
  const refuse = (detail: string): never => {
    throw new Error(`campaign "${id}" ${detail}`);
  };

  const lower = (detector: DetectorSpec, objective: string): Detector => {
    if ("all" in detector) return { all: detector.all.map((one) => lower(one, objective)) };
    if ("any" in detector) return { any: detector.any.map((one) => lower(one, objective)) };
    if ("not" in detector) return { not: lower(detector.not, objective) };
    if ("path" in detector) {
      const { convention, ...rest } = detector.path;
      const conventionSource =
        convention === undefined
          ? undefined
          : typeof convention === "string"
            ? CONVENTIONS[convention]?.source
            : convention.regex;
      if (convention !== undefined && conventionSource === undefined) {
        refuse(`(${objective}) names an unknown convention "${String(convention)}".`);
      }
      if (conventionSource !== undefined && rest.subject === undefined) {
        refuse(
          `(${objective}) states a path convention with no \`subject\`: say which ` +
            `capture group of \`file\` holds the name the convention is about.`,
        );
      }
      return {
        path: {
          file: globsOf(rest.file),
          ...(rest.fileNot === undefined ? {} : { fileNot: globsOf(rest.fileNot) }),
          ...(rest.subject === undefined ? {} : { subject: rest.subject }),
          ...(conventionSource === undefined ? {} : { convention: conventionSource }),
        },
      };
    }
    if ("imports" in detector) {
      const { resolves, symbols } = detector.imports;
      return {
        imports: {
          resolves: typeof resolves === "string" ? asPath(resolves) : resolves,
          ...(symbols === undefined ? {} : { symbols: [...symbols] }),
        },
      };
    }
    if ("exports" in detector) {
      const term = detector.exports;
      return {
        exports: {
          ...(term.name === undefined ? {} : { name: asName(term.name) }),
          ...(term.kinds === undefined ? {} : { kinds: [...term.kinds] }),
          ...(term.declares === undefined ? {} : { declares: [...term.declares] }),
          ...(term.reexport === undefined ? {} : { reexport: term.reexport }),
        },
      };
    }
    if ("members" in detector) {
      const term = detector.members;
      return {
        members: {
          subject: term.subject,
          ...(term.name === undefined ? {} : { name: asName(term.name) }),
          ...(term.in === undefined ? {} : { in: asName(term.in) }),
          ...(term.declares === undefined ? {} : { declares: [...term.declares] }),
        },
      };
    }
    if ("requires" in detector) return { requires: [...detector.requires] };
    if ("content" in detector) return { content: { regex: detector.content.regex } };
    if ("report" in detector) {
      // Exactly one of `command` and `file`, and a pattern for `regex`: the
      // manifest schema refused anything else at decode.
      const term = detector.report;
      return {
        report: {
          ...(term.command === undefined ? {} : { command: globsOf(term.command) }),
          ...(term.file === undefined ? {} : { file: globsOf(term.file) }),
          format: term.format,
          ...(term.pattern === undefined ? {} : { pattern: term.pattern }),
          ...(term.codes === undefined ? {} : { codes: [...term.codes] }),
          ...(term.codesNot === undefined ? {} : { codesNot: [...term.codesNot] }),
        },
      };
    }
    if ("syntax" in detector) {
      const { where } = detector.syntax;
      const narrowed =
        where === undefined
          ? {}
          : {
              where: Object.fromEntries(
                Object.entries(where).map(([capture, narrowing]) => [
                  capture,
                  {
                    ...(narrowing.regex === undefined ? {} : { regex: narrowing.regex }),
                    ...(narrowing.binding === undefined
                      ? {}
                      : {
                          binding: {
                            resolves:
                              typeof narrowing.binding.resolves === "string"
                                ? asPath(narrowing.binding.resolves)
                                : narrowing.binding.resolves,
                            ...(narrowing.binding.member === undefined
                              ? {}
                              : { member: [...narrowing.binding.member] }),
                          },
                        }),
                  },
                ]),
              ),
            };
      return { syntax: { rule: syntaxRuleOf(detector.syntax), ...narrowed } };
    }
    return { fn: detector.fn };
  };

  // A probe without a source proves only the path; a detector that reads
  // the file needs the file. Refused here, with the term named, rather than
  // at load as a probe that mysteriously never fires.
  const checkProbes = (
    what: string,
    detector: DetectorSpec,
    probes: CampaignProbesSpec | undefined,
  ): { fires: ReadonlyArray<CampaignProbe>; ignores: ReadonlyArray<CampaignProbe> } => {
    const leaves = leafTermsOf(detector);
    const needsSource = TERMS_NEEDING_SOURCE.filter((term) => leaves.includes(term));
    const all = [...(probes?.fires ?? []), ...(probes?.ignores ?? [])];
    const sourceless = all.find((probe) => probe.source === undefined);
    if (needsSource.length > 0 && sourceless !== undefined) {
      refuse(
        `(${what}) has a probe (${sourceless.path}) with no \`source\`, and its ` +
          `detector holds a ${needsSource.map((term) => `\`${term}\``).join(", ")} term, which ` +
          `a path alone cannot exercise. Give every probe a source.`,
      );
    }
    return { fires: [...(probes?.fires ?? [])], ignores: [...(probes?.ignores ?? [])] };
  };

  const scopeSpec = campaign.scope ?? "**";
  const scopeGlobs =
    typeof scopeSpec === "string" || Array.isArray(scopeSpec)
      ? globsOf(scopeSpec as string | ReadonlyArray<string>)
      : globsOf((scopeSpec as { readonly path: string | ReadonlyArray<string> }).path);
  const extensions =
    typeof scopeSpec === "string" || Array.isArray(scopeSpec)
      ? []
      : [...((scopeSpec as { readonly extensions?: ReadonlyArray<string> }).extensions ?? [])];

  const objectives: Array<ObjectiveRule> = Object.entries(campaign.objectives).map(
    ([objectiveId, spec]) => {
      const name = `campaign/${id}/${objectiveId}`;
      const message = spec.how ?? campaign.how ?? `${objectiveId} (${id})`;
      const why = spec.why ?? campaign.why;
      const base = {
        name,
        id: objectiveId,
        campaign: id,
        message,
        ...(why === undefined ? {} : { why }),
        holdout: spec.holdout,
        ...(spec.until === undefined ? {} : { until: spec.until }),
      };
      if (spec.match !== undefined) {
        return {
          ...base,
          match: lower(spec.match, objectiveId),
          probes: checkProbes(objectiveId, spec.match, spec.probes),
        };
      }
      const term = spec.sector ?? refuse(`(${objectiveId}) has neither \`match\` nor \`sector\`.`);
      const sector: SectorTerm =
        "has" in term
          ? { has: lower(term.has, objectiveId) }
          : "oneRoot" in term
            ? { oneRoot: true }
            : { oneHost: globsOf(term.oneHost).map(asPath) };
      return {
        ...base,
        sector,
        probes:
          "has" in term
            ? checkProbes(objectiveId, term.has, spec.probes)
            : {
                fires: [...(spec.probes?.fires ?? [])],
                ignores: [...(spec.probes?.ignores ?? [])],
              },
      };
    },
  );

  // The perimeter, its globs resolved. A `match` perimeter is proven like
  // an objective; the loader adds the end-shape check, which needs the
  // objectives evaluated on the probe.
  const perimeterSpec = campaign.perimeter;
  const perimeter: PerimeterRule | undefined =
    perimeterSpec === undefined
      ? undefined
      : perimeterSpec === "file"
        ? { kind: "file" }
        : perimeterSpec === "nx"
          ? { kind: "nx" }
          : "glob" in perimeterSpec
            ? { kind: "glob", glob: globsOf(perimeterSpec.glob).map(asPath) }
            : "marker" in perimeterSpec
              ? {
                  kind: "marker",
                  marker: asWhole(perimeterSpec.marker),
                  ...(perimeterSpec.probes === undefined
                    ? {}
                    : {
                        probes: {
                          fires: globsOf(perimeterSpec.probes.fires ?? []),
                          ignores: globsOf(perimeterSpec.probes.ignores ?? []),
                        },
                      }),
                }
              : {
                  kind: "match",
                  match: lower(perimeterSpec.match, "perimeter"),
                  unit: perimeterSpec.holdout ?? "declaration",
                  probes: checkProbes("perimeter", perimeterSpec.match, perimeterSpec.probes),
                };
  if (perimeter?.kind === "match" && perimeter.probes.fires.length === 0) {
    refuse(
      `has a \`match\` perimeter with no \`probes.fires\`. A perimeter is the sector's identity ` +
        `across every phase, so it is proven on a sector in its end shape as well as its first.`,
    );
  }

  // The phases. An `endState` written on the campaign belongs to the last
  // phase; a campaign with none and an end state gets one phase, `end`.
  const phaseSpecs: Array<PhaseSpec> = [...(campaign.phases ?? [])];
  if (campaign.endState !== undefined) {
    const last = phaseSpecs.at(-1);
    if (last === undefined) phaseSpecs.push({ id: "end", endState: campaign.endState });
    else if (last.endState !== undefined) {
      refuse(`writes an \`endState\` on the campaign and on its last phase; write one.`);
    } else phaseSpecs[phaseSpecs.length - 1] = { ...last, endState: campaign.endState };
  }
  const objectiveIds = new Set(objectives.map((one) => one.id));
  const namedBy = new Map<string, string>();
  const phases: Array<PhaseRule> = [];
  phaseSpecs.forEach((phase, index) => {
    if (phases.some((one) => one.id === phase.id)) {
      refuse(`names the phase "${phase.id}" twice.`);
    }
    for (const objectiveId of phase.objectives ?? []) {
      if (!objectiveIds.has(objectiveId)) {
        refuse(
          `phase "${phase.id}" names an objective "${objectiveId}" the campaign does not declare.`,
        );
      }
      const already = namedBy.get(objectiveId);
      if (already !== undefined) {
        refuse(
          `names the objective "${objectiveId}" in two phases ("${already}" and "${phase.id}"); ` +
            `an objective belongs to at most one.`,
        );
      }
      namedBy.set(objectiveId, phase.id);
    }
    const expanded: Array<string> = [...(phase.objectives ?? [])];
    if (phase.endState !== undefined) {
      const families = endStateFamiliesOf(phase.endState, resolve, languages);
      if (families.length === 0) {
        refuse(`phase "${phase.id}" carries an \`endState\` that lowers to no rule at all.`);
      }
      for (const family of families) {
        const objectiveId = endStateObjectiveId(family);
        if (objectiveIds.has(objectiveId)) {
          refuse(`declares an objective "${objectiveId}", which its endState needs for itself.`);
        }
        objectiveIds.add(objectiveId);
        namedBy.set(objectiveId, phase.id);
        expanded.push(objectiveId);
        objectives.push({
          name: `campaign/${id}/${objectiveId}`,
          id: objectiveId,
          campaign: id,
          message:
            campaign.how ??
            `The sector's end state, as phase "${phase.id}" writes it: a ${family} violation against the sector-relative tree.`,
          holdout: "declaration",
          endState: { phase: phase.id, family },
          probes: { fires: [], ignores: [] },
        });
      }
    }
    const defined = expanded.length > 0 || phase.attested === true;
    if (!defined && phase.intent === undefined) {
      refuse(
        `phase "${phase.id}" names no objective and states no \`intent\`. An open phase is a ` +
          `stated intent; a defined one names at least one objective (or is attested).`,
      );
    }
    if (!defined && index !== phaseSpecs.length - 1) {
      refuse(
        `phase "${phase.id}" is open (it names no objective) and is not last. A plan that has ` +
          `not been written cannot sit in the middle of one that has.`,
      );
    }
    phases.push({
      id: phase.id,
      ...(phase.intent === undefined ? {} : { intent: phase.intent }),
      objectives: expanded,
      attested: phase.attested === true,
      ...(phase.onTouch === undefined ? {} : { onTouch: phase.onTouch }),
      ...(phase.endState === undefined ? {} : { endState: phase.endState }),
      concessions: [...(phase.concessions ?? [])],
      hash: "",
    });
  });
  // A window: from the phase that names the objective until the phase
  // `until` names, exclusive. Refused when `until` names no phase, or one
  // at or before the naming phase — the two ways a remove or a reorder
  // leaves a window empty.
  for (const objective of objectives) {
    if (objective.until === undefined) continue;
    const to = phases.findIndex((one) => one.id === objective.until);
    if (to === -1) {
      refuse(
        `objective "${objective.id}" runs \`until: ${objective.until}\`, and no phase has that id.`,
      );
    }
    const from = phases.findIndex((one) => one.id === namedBy.get(objective.id));
    if (from !== -1 && to <= from) {
      refuse(
        `objective "${objective.id}" is named by phase "${phases[from]?.id ?? ""}" and runs ` +
          `\`until: ${objective.until}\`, which is not after it; the window is empty.`,
      );
    }
  }
  const hashed = phases.map((phase, index) => ({
    ...phase,
    hash: digest({
      index,
      id: phase.id,
      attested: phase.attested,
      endState: phase.endState ?? null,
      objectives: phase.objectives.map((objectiveId) => {
        const objective = objectives.find((one) => one.id === objectiveId);
        return {
          id: objectiveId,
          holdout: objective?.holdout,
          match: objective?.match ?? null,
          sector: objective?.sector ?? null,
          until: objective?.until ?? null,
        };
      }),
    }),
  }));
  // The end is the last phase, so a change to it is a change to that
  // phase's hash already; a campaign with no phases has an end that is
  // every objective, digested as a phase of its own would be.
  if (perimeter?.kind === "marker" && hashed.some((phase) => phase.endState !== undefined)) {
    // A marker may list the globs it owns, so its sectors may have several
    // roots — and a sector-relative tree needs one. Refused at lowering,
    // where the two are in view together; `one-root` as an earlier phase's
    // objective is how a campaign gets there.
    refuse(
      `carries an \`endState\` over a \`marker\` perimeter. A marker may list the globs it owns, ` +
        `so a sector may have several roots, and a sector-relative tree needs one: use a ` +
        `\`glob\`, \`file\` or \`nx\` perimeter, or reach one root first with a \`oneRoot\` objective.`,
    );
  }

  return {
    name: `campaign/${id}`,
    id,
    ...(campaign.title === undefined ? {} : { title: campaign.title }),
    ...(campaign.why === undefined ? {} : { why: campaign.why }),
    ...(campaign.owner === undefined ? {} : { owner: campaign.owner }),
    scope: scopeGlobs.map(asPath),
    extensions,
    ...(campaign.legacy === undefined ? {} : { legacy: globsOf(campaign.legacy).map(asPath) }),
    ...(perimeter === undefined ? {} : { perimeter }),
    ...(campaign.onTouch === undefined ? {} : { onTouch: campaign.onTouch }),
    phases: hashed,
    objectives,
    ...(campaign.staleAfter === undefined ? {} : { staleAfter: durationMs(campaign.staleAfter) }),
    onComplete: campaign.onComplete ?? "keep",
  };
};

// Every campaign in the manifest, lowered. The one entry point the loader
// extension calls: the core hands over what it decoded of the rest of the
// manifest (`aliases`, `resolve`) and the language packs it was composed
// with, and gets back the rules the evaluators compile.
export const lowerCampaigns = (
  spec: CampaignsManifest,
  config: Pick<Manifest, "aliases" | "resolve">,
  languages: ReadonlyArray<ProbeLanguage>,
): ReadonlyArray<CampaignRule> =>
  Object.entries(spec.campaigns ?? {}).map(([id, campaign]) =>
    lowerCampaign(id, campaign, config.aliases ?? {}, config.resolve, languages),
  );
