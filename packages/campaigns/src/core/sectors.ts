import type { Violation } from "@goodbones/core";

import type { CompiledCampaign, CompiledPerimeter } from "./campaigns.js";

// A sector is the thing that moves through a campaign's phases as one,
// whatever its size — a bounded context, a component folder, a single file.
// It is never listed in the manifest: the code births it, through the
// campaign's perimeter, and this module is where that reading happens.
// Given the files in a campaign's scope (and, for a `match` perimeter, what
// the perimeter's detector finds in each), it says which sector every file
// is in, what the sector's roots are, and which files no sector claims —
// the legacy, which stands at the first phase and is not a sink.
//
// Holdouts are keyed relative to the sector's root, so a lift from one host
// to another moves nothing in the ledger. The root is the marker's folder,
// the matched glob, the file's own folder, or the repository for the
// implicit sector and the legacy.

// The one sector a campaign with no perimeter has: the whole scope.
export const IMPLICIT_SECTOR = "scope";

// What no sector has claimed.
export const LEGACY_SECTOR = "legacy";

export type Sector = {
  readonly name: string;
  // The folders the sector's files sit under, repo-relative without a
  // trailing slash; `""` is the repository. The first is the primary root.
  readonly roots: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
  // For a marker sector, the marker file; for a match sector, the
  // declaration the perimeter matched.
  readonly marker: string | null;
  readonly declaration: { readonly file: string; readonly anchor: string } | null;
};

export type SectorIndex = {
  readonly sectors: ReadonlyMap<string, Sector>;
  // The legacy: files in the scope no sector claims.
  readonly legacy: ReadonlyArray<string>;
  // The sector a file is in — a sector's name, `LEGACY_SECTOR`, or `null`
  // when the file is outside the campaign (outside the scope, or unclaimed
  // and outside `legacy`).
  readonly sectorOf: (file: string) => string | null;
  // The sector a hit is in. For a `match` perimeter a file may hold several
  // sectors, one per matched declaration; a hit is in the one whose anchor
  // it carries, else in the file's only sector, else in the legacy.
  readonly sectorOfHit: (file: string, subject: string | null) => string | null;
  // Files two sectors claim — nested perimeters — which fail `check`.
  readonly drift: ReadonlyArray<{ readonly file: string; readonly sectors: ReadonlyArray<string> }>;
};

// What a marker file says about its sector, when it exports a `sector`
// object: `export const sector = { name: "billing", owns: ["src/billing/**"] }`.
export type SectorMarker = {
  readonly name?: string | undefined;
  readonly owns?: ReadonlyArray<string> | undefined;
};

const MARKER_EXPORT = /export\s+const\s+sector(?:\s*:[^=]*)?\s*=\s*\{/;

// Reads the exported `sector` object out of a marker's text, tolerating the
// object literal as a person writes it — unquoted keys, single quotes, a
// trailing comma, `as const`. Nothing is executed. `null` when the file
// exports no such object; a throw when it does and the object cannot be read.
export const parseSectorMarker = (text: string): SectorMarker | null => {
  const at = MARKER_EXPORT.exec(text);
  if (at === null) return null;
  const start = at.index + at[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error("the `sector` object's braces do not balance");
  const literal = text
    .slice(start, end + 1)
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, inner: string) => JSON.stringify(inner))
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, "$1");
  let parsed: unknown;
  try {
    parsed = JSON.parse(literal);
  } catch (cause) {
    throw new Error(`the \`sector\` object is not a plain literal: ${String(cause)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the `sector` export is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const name = record.name;
  const owns = record.owns;
  if (name !== undefined && typeof name !== "string") {
    throw new Error("the `sector` object's `name` is not a string");
  }
  if (
    owns !== undefined &&
    (!Array.isArray(owns) || owns.some((one: unknown) => typeof one !== "string"))
  ) {
    throw new Error("the `sector` object's `owns` is not a list of globs");
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(owns === undefined ? {} : { owns: owns as ReadonlyArray<string> }),
  };
};

const folderOf = (file: string): string => {
  const at = file.lastIndexOf("/");
  return at === -1 ? "" : file.slice(0, at);
};

const basenameOf = (file: string): string => file.slice(file.lastIndexOf("/") + 1);

// The path without its extension — a `file` sector's identity, so that
// `a.js → a.ts` is one sector before and after.
export const withoutExtension = (file: string): string => {
  const base = basenameOf(file);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? file : file.slice(0, file.length - (base.length - dot));
};

// The fixed prefix of a glob — everything before its first wildcard, cut
// at a folder boundary — which is the root the glob's files sit under.
export const fixedPrefixOf = (glob: string): string => {
  const wildcard = glob.search(/[*?[{]/);
  const fixed = wildcard === -1 ? glob : glob.slice(0, wildcard);
  const cut = fixed.lastIndexOf("/");
  return cut === -1 ? "" : fixed.slice(0, cut);
};

const under = (root: string, file: string): boolean =>
  root === "" || file === root || file.startsWith(`${root}/`);

export type SectorDiscovery = {
  // The files in the campaign's scope, repo-relative.
  readonly files: ReadonlyArray<string>;
  readonly readText: (file: string) => string | null;
  // Compiles a repo-relative glob a marker's `owns` lists, as the manifest
  // compiles its own; the core owns no glob syntax.
  readonly globToRegExp: (glob: string) => RegExp;
  // For a `match` perimeter: the anchors the perimeter's detector finds in
  // one file — one sector each.
  readonly perimeterMatches?: ((file: string) => ReadonlyArray<string>) | undefined;
  // For an `nx` perimeter: the workspace's projects, as the host read them.
  readonly projects?: ReadonlyArray<{ readonly name: string; readonly root: string }> | undefined;
};

type Claim = { readonly sector: string; readonly root: string };

const indexOf = (
  rule: CompiledCampaign,
  files: ReadonlyArray<string>,
  sectors: ReadonlyMap<string, Sector>,
  claims: ReadonlyMap<string, ReadonlyArray<Claim>>,
): SectorIndex => {
  const seen = new Set(files);
  const legacyOf = (file: string): string | null =>
    rule.legacy === null || rule.legacy.some((pattern) => pattern.test(file))
      ? LEGACY_SECTOR
      : null;
  // A file the campaign never saw — outside its scope, or not a source
  // file at all — is in no sector.
  const sectorOf = (file: string): string | null => {
    if (!seen.has(file)) return null;
    const claimed = claims.get(file);
    if (claimed !== undefined && claimed.length > 0) return claimed[0]?.sector ?? null;
    return legacyOf(file);
  };
  const legacy = files.filter((file) => sectorOf(file) === LEGACY_SECTOR);
  const drift = [...claims.entries()]
    .filter(([, claimed]) => new Set(claimed.map((one) => one.sector)).size > 1)
    .map(([file, claimed]) => ({
      file,
      sectors: [...new Set(claimed.map((one) => one.sector))].sort(),
    }));
  const sectorOfHit = (file: string, subject: string | null): string | null => {
    if (rule.perimeter?.kind !== "match") return sectorOf(file);
    const claimed = claims.get(file) ?? [];
    if (subject !== null) {
      const anchor = subject.split("#")[0] ?? subject;
      const own = claimed.find((one) => sectors.get(one.sector)?.declaration?.anchor === anchor);
      if (own !== undefined) return own.sector;
    }
    if (claimed.length === 1) return claimed[0]?.sector ?? null;
    return legacyOf(file);
  };
  return { sectors, legacy, sectorOf, sectorOfHit, drift };
};

// The sectors of one campaign, read off its files through its perimeter.
export const discoverSectors = (rule: CompiledCampaign, input: SectorDiscovery): SectorIndex => {
  const files = [...input.files].sort();
  const sectors = new Map<string, Sector>();
  const claims = new Map<string, Array<Claim>>();
  const claim = (file: string, sector: string, root: string): void => {
    claims.set(file, [...(claims.get(file) ?? []), { sector, root }]);
  };
  const add = (sector: Sector): void => {
    const known = sectors.get(sector.name);
    // A name declared by two markers is one sector with both roots.
    sectors.set(
      sector.name,
      known === undefined
        ? sector
        : {
            ...known,
            roots: [...new Set([...known.roots, ...sector.roots])],
            files: [...new Set([...known.files, ...sector.files])].sort(),
          },
    );
    for (const file of sector.files) claim(file, sector.name, rootOf(sector, file));
  };

  const perimeter: CompiledPerimeter | null = rule.perimeter;
  if (perimeter === null) {
    add({ name: IMPLICIT_SECTOR, roots: [""], files, marker: null, declaration: null });
    return indexOf(rule, files, sectors, claims);
  }

  switch (perimeter.kind) {
    case "file": {
      for (const file of files) {
        add({
          name: withoutExtension(file),
          roots: [folderOf(file)],
          files: [file],
          marker: null,
          declaration: null,
        });
      }
      break;
    }
    case "glob": {
      const byName = new Map<string, Array<string>>();
      for (const file of files) {
        for (const pattern of perimeter.glob) {
          const found = pattern.exec(file);
          if (found === null) continue;
          const name = found[0].replace(/\/$/, "");
          byName.set(name, [...(byName.get(name) ?? []), file]);
          break;
        }
      }
      for (const [name, own] of byName) {
        add({ name, roots: [name], files: own, marker: null, declaration: null });
      }
      break;
    }
    case "marker": {
      const markers = files.filter((file) => perimeter.marker.some((one) => one.test(file)));
      for (const marker of markers) {
        const text = input.readText(marker) ?? "";
        let read: SectorMarker | null;
        try {
          read = parseSectorMarker(text);
        } catch (cause) {
          throw new Error(`the sector marker ${marker} does not read: ${String(cause)}`);
        }
        const folder = folderOf(marker);
        const name = read?.name ?? basenameOf(folder === "" ? "." : folder);
        const owns = read?.owns ?? [];
        const patterns = owns.map((glob) => input.globToRegExp(glob));
        const roots = [folder, ...owns.map(fixedPrefixOf)].filter(
          (root, at, all) => all.indexOf(root) === at,
        );
        const own = files.filter(
          (file) =>
            (owns.length === 0 && under(folder, file)) ||
            patterns.some((pattern) => pattern.test(file)) ||
            file === marker,
        );
        add({ name, roots, files: own, marker, declaration: null });
      }
      break;
    }
    case "match": {
      const matches = input.perimeterMatches ?? (() => []);
      for (const file of files) {
        for (const anchor of matches(file)) {
          add({
            name: `${file}#${anchor}`,
            roots: [folderOf(file)],
            files: [file],
            marker: null,
            declaration: { file, anchor },
          });
        }
      }
      break;
    }
    case "nx": {
      for (const project of input.projects ?? []) {
        const own = files.filter((file) => under(project.root, file));
        if (own.length === 0) continue;
        add({
          name: project.name,
          roots: [project.root],
          files: own,
          marker: null,
          declaration: null,
        });
      }
      break;
    }
  }
  return indexOf(rule, files, sectors, claims);
};

// The root a file of the sector sits under: the first of the sector's
// roots that prefixes it, so an entry written relative to it survives the
// sector moving as one.
export const rootOf = (sector: Sector, file: string): string =>
  sector.roots.find((root) => under(root, file)) ?? "";

// A hit's ledger entry, relative to the sector's root: `file#subject`, with
// the file written from the root. A sector's own holdout (`holdout: sector`)
// is `~`, the sector itself.
export const SECTOR_HOLDOUT = "~";

export const entryOf = (violation: Violation, root: string): string => {
  const stripped = root === "" ? violation.file : violation.file.slice(root.length + 1);
  const relative = stripped === "" ? violation.file : stripped;
  return violation.subject === null ? relative : `${relative}#${violation.subject}`;
};

// The sector a name belongs to in an index, the legacy included as a
// synthetic sector rooted at the repository.
export const sectorNamed = (index: SectorIndex, name: string): Sector | null =>
  name === LEGACY_SECTOR
    ? { name, roots: [""], files: index.legacy, marker: null, declaration: null }
    : (index.sectors.get(name) ?? null);

// Where one file's hits fall, for a host that sees one file at a time. A
// `glob` or `file` perimeter answers from the path; `match` from the
// anchors the perimeter's detector found in the file; `marker` and `nx`
// from an index the host built at load, since those need the other files.
// A file outside the scope, or unclaimed and outside `legacy`, is in no
// sector, and the answer is `null`.
export type Placement = { readonly sector: string; readonly root: string };

export const membershipOf = (
  rule: CompiledCampaign,
  file: string,
  index: SectorIndex | null,
  anchors: ReadonlyArray<string>,
): ((subject: string | null) => Placement | null) => {
  const inScope = rule.scope.some((pattern) => pattern.test(file));
  if (!inScope) return () => null;
  const legacy = (): Placement | null =>
    rule.legacy === null || rule.legacy.some((pattern) => pattern.test(file))
      ? { sector: LEGACY_SECTOR, root: "" }
      : null;
  const perimeter = rule.perimeter;
  if (perimeter === null) return () => ({ sector: IMPLICIT_SECTOR, root: "" });
  switch (perimeter.kind) {
    case "file": {
      const placement = { sector: withoutExtension(file), root: folderOf(file) };
      return () => placement;
    }
    case "glob": {
      for (const pattern of perimeter.glob) {
        const found = pattern.exec(file);
        if (found === null) continue;
        const name = found[0].replace(/\/$/, "");
        return () => ({ sector: name, root: name });
      }
      return legacy;
    }
    case "match": {
      const own = anchors.map((anchor) => ({ sector: `${file}#${anchor}`, root: folderOf(file) }));
      return (subject) => {
        if (subject !== null) {
          const anchor = subject.split("#")[0] ?? subject;
          const found = own.find((one) => one.sector === `${file}#${anchor}`);
          if (found !== undefined) return found;
        }
        return own.length === 1 ? (own[0] ?? null) : legacy();
      };
    }
    case "marker":
    case "nx": {
      if (index === null) return legacy;
      const name = index.sectorOf(file);
      if (name === null) return () => null;
      const sector = sectorNamed(index, name);
      const placement = { sector: name, root: sector === null ? "" : rootOf(sector, file) };
      return () => placement;
    }
  }
};
