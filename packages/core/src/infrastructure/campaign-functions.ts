import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { ConfigInvalid } from "../domain/architecture-error.js";
import type { CampaignPredicate } from "../ports/campaign-predicate.js";

// A campaign's `fn` term names a predicate function as `module#export`,
// resolved relative to the root manifest. Importing it touches the module
// loader, which is why this lives in infrastructure and both hosts call it
// before `loadPolicy`: the core receives the functions as a map and never
// imports anything.
//
// A `.mjs` manifest may write the function itself in place of the string.
// It is lifted out here, keyed by a synthesized name, and the manifest handed
// back with the string in its place — so the schema, which decodes a data
// file and a module alike, sees one shape. The whole value is walked, not
// only `campaigns`, so a term written in a `defs` fragment is found too.

export type LoadedCampaignFunctions = {
  readonly functions: ReadonlyMap<string, CampaignPredicate>;
  // The manifest with every function value replaced by its synthesized name.
  readonly manifest: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const REFERENCE = /^(.+)#([A-Za-z_$][\w$]*)$/;

// A `fn` term is an object whose one key is `fn`.
const isFnTerm = (value: Record<string, unknown>): boolean =>
  "fn" in value && Object.keys(value).length === 1;

export const loadCampaignFunctions = async (
  manifestPath: string,
  rawManifest: unknown,
): Promise<LoadedCampaignFunctions> => {
  const functions = new Map<string, CampaignPredicate>();
  const root = path.dirname(manifestPath);
  const refuse = (detail: string): never => {
    throw new ConfigInvalid({ configPath: manifestPath, detail });
  };

  const imported = async (reference: string): Promise<void> => {
    if (functions.has(reference)) return;
    const parsed = REFERENCE.exec(reference);
    if (parsed === null) {
      return refuse(
        `the \`fn\` term ${JSON.stringify(reference)} is not \`module#export\`: name the ` +
          `module (relative to the manifest) and the export, joined by \`#\`.`,
      );
    }
    const [, module = "", exportName = ""] = parsed;
    const at = path.resolve(root, module);
    let loaded: unknown;
    try {
      loaded = await import(pathToFileURL(at).href);
    } catch (cause) {
      return refuse(
        `the \`fn\` term ${JSON.stringify(reference)} names a module that does not load: ${String(cause)}`,
      );
    }
    const found = isRecord(loaded) ? loaded[exportName] : undefined;
    if (typeof found !== "function") {
      return refuse(
        `the \`fn\` term ${JSON.stringify(reference)} names an export that is not a function ` +
          `(${found === undefined ? "absent" : typeof found}).`,
      );
    }
    functions.set(reference, found as CampaignPredicate);
  };

  let synthesized = 0;
  const lift = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) {
      const items: Array<unknown> = [];
      for (const item of value) items.push(await lift(item));
      return items;
    }
    if (!isRecord(value)) return value;
    if (isFnTerm(value)) {
      const fn = value.fn;
      if (typeof fn === "function") {
        synthesized += 1;
        const name = `<manifest>#fn${String(synthesized)}`;
        functions.set(name, fn as CampaignPredicate);
        return { fn: name };
      }
      if (typeof fn === "string") await imported(fn);
      return value;
    }
    const rebuilt: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) rebuilt[key] = await lift(entry);
    return rebuilt;
  };

  return { functions, manifest: await lift(rawManifest) };
};
