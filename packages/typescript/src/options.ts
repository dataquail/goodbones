import { type ResolveScope, ScopeInvalid } from "@goodbones/core";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

// What a `resolve.scopes` entry for TypeScript may say. The manifest carries
// these opaquely; this is where they mean something. Every one of them is an
// `unrs-resolver` option, and the defaults are the resolver's own.
export const TypescriptScopeOptions = Schema.Struct({
  // The tsconfig whose `paths` and `baseUrl` resolve this scope's imports,
  // repo-relative. Its `paths` targets should be extensionless: a mapped
  // target is a template, and `x.js` against a `.ts`-suffixed one looks for
  // `x.js.ts`.
  tsconfig: Schema.String,
  extensions: Schema.optionalKey(Schema.Array(Schema.String)),
  conditionNames: Schema.optionalKey(Schema.Array(Schema.String)),
  mainFields: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type TypescriptScopeOptions = typeof TypescriptScopeOptions.Type;

// Unknown keys are refused: a misspelled `conditionNames` would otherwise be
// a resolver quietly built on defaults, and every rule about that scope would
// be evaluated against the wrong files.
const decode = Schema.decodeUnknownResult(TypescriptScopeOptions, {
  onExcessProperty: "error",
  reportInput: true,
});

export const decodeTypescriptScopeOptions = (
  scope: ResolveScope,
): Result.Result<TypescriptScopeOptions, ScopeInvalid> =>
  Result.mapError(
    decode(scope.options ?? {}),
    (issue) =>
      new ScopeInvalid({
        files: scope.files,
        language: scope.language,
        detail: `options do not decode as TypeScript resolver options — ${String(issue)}`,
      }),
  );
