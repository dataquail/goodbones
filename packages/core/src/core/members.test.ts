import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import type { MemberRule } from "../domain/architecture-config.js";
import { makeFactExtractorFake } from "../infrastructure/fact-extractor-fake.js";
import {
  compileMemberRules,
  evaluateMemberSite,
  memberRulesFailingTheirProbe,
  memberRulesSelecting,
  type MemberSite,
} from "./members.js";

const compile = (rules: ReadonlyArray<MemberRule>) => {
  const compiled = compileMemberRules(rules);

  if (Result.isFailure(compiled)) throw compiled.failure;

  return compiled.success;
};

const PORT = "packages/server/src/modules/todos/domain/todo/todos.repository.ts";
const VIEW = "packages/web/features/todos/todos.view.tsx";

const dumbReads: MemberRule = {
  name: "dumb-repository-ports-reads",
  message: 'Port method "{name}" is not a read this vocabulary admits.',
  probe: { from: PORT, in: "TodosRepositoryShape", name: "findOneById" },
  from: "^packages/server/src/modules/[^/]+/domain/[^/]+/[^/]+\\.repository\\.ts$",
  subject: "members",
  declares: ["type", "interface"],
  in: "Repository(Shape)?$",
  match: "^find",
  allow: "^find(One|Many)$",
};

const viewHooks: MemberRule = {
  name: "view-hooks-allowlist",
  message: "`{name}` puts state in the View.",
  probe: { from: VIEW, name: "useState" },
  from: "^packages/web/features/.*\\.view\\.tsx$",
  subject: "calls",
  match: "^use[A-Z]",
  allow: "^(useAtomValue|useId)$",
};

const violationsAt = (rules: ReadonlyArray<MemberRule>, site: MemberSite) =>
  evaluateMemberSite(memberRulesSelecting(compile(rules), site.file), site).map(
    (violation) => violation.ruleName,
  );

const typeMember = (name: string, declaration = "TodosRepositoryShape"): MemberSite => ({
  file: PORT,
  subject: "members",
  name,
  in: declaration,
  declares: "type",
});

const classMember = (name: string, declaration = "TodosRepositoryShape"): MemberSite => ({
  file: PORT,
  subject: "members",
  name,
  in: declaration,
  declares: "class",
});

const call = (name: string, file = VIEW): MemberSite => ({ file, subject: "calls", name });

describe("evaluateMemberSite", () => {
  describe("type members", () => {
    it("reports a name the rule speaks to but does not admit", () => {
      expect(violationsAt([dumbReads], typeMember("findOneByEmail"))).toEqual([
        "dumb-repository-ports-reads",
      ]);
    });

    it("admits the vocabulary the rule allows", () => {
      expect(violationsAt([dumbReads], typeMember("findMany"))).toEqual([]);
    });

    it("stays silent on names outside its match", () => {
      expect(violationsAt([dumbReads], typeMember("insertOne"))).toEqual([]);
    });

    // The `in` filter is what keeps a helper type in the same file out of scope.
    it("ignores a declaration its `in` pattern does not name", () => {
      expect(violationsAt([dumbReads], typeMember("findOneById", "TodoRow"))).toEqual([]);
    });

    // `declares` is the selector that carries what `type-members` used to
    // mean. A rule about a type's members says nothing about a class of the
    // same name; a rule about classes says nothing about types; a rule that
    // names no kind speaks to every declaration.
    it("speaks only to the declaration kinds it names", () => {
      expect(violationsAt([dumbReads], classMember("findOneByEmail"))).toEqual([]);

      const classes: MemberRule = { ...dumbReads, name: "class-reads", declares: ["class"] };
      expect(violationsAt([classes], classMember("findOneByEmail"))).toEqual(["class-reads"]);
      expect(violationsAt([classes], typeMember("findOneByEmail"))).toEqual([]);

      const { declares: _dropped, ...anyDeclaration } = dumbReads;
      const every: MemberRule = { ...anyDeclaration, name: "any-reads" };
      expect(violationsAt([every], classMember("findOneByEmail"))).toEqual(["any-reads"]);
      expect(violationsAt([every], typeMember("findOneByEmail"))).toEqual(["any-reads"]);
    });

    it("ignores a file its `from` pattern does not select", () => {
      expect(
        violationsAt([dumbReads], {
          ...typeMember("findOneById"),
          file: "packages/server/src/modules/todos/commands/create-todo.handler.ts",
        }),
      ).toEqual([]);
    });
  });

  describe("calls", () => {
    it("reports a call outside the allowlist", () => {
      expect(violationsAt([viewHooks], call("useEffect"))).toEqual(["view-hooks-allowlist"]);
    });

    it("admits an allowlisted call", () => {
      expect(violationsAt([viewHooks], call("useAtomValue"))).toEqual([]);
    });

    it("does not treat a non-hook name as one", () => {
      expect(violationsAt([viewHooks], call("useless"))).toEqual([]);
    });

    it("does not apply a call rule to a type member of the same name", () => {
      expect(
        violationsAt([viewHooks], { file: VIEW, subject: "members", name: "useEffect" }),
      ).toEqual([]);
    });
  });

  // The two halves of one vocabulary, split so each can give its own advice —
  // which is what replaced the old rule's branch inside the message string.
  it("uses matchNot to split one vocabulary across two rules", () => {
    const dumbWrites: MemberRule = {
      name: "dumb-repository-ports-writes",
      message: 'Port method "{name}" reads like a domain verb.',
      probe: { from: PORT, in: "TodosRepositoryShape", name: "grantRole" },
      from: dumbReads.from,
      subject: "members",
      declares: ["type", "interface"],
      in: "Repository(Shape)?$",
      matchNot: "^find",
      allow: "^(insert|update|delete|upsert)(One|Many)$",
    };

    const rules = [dumbReads, dumbWrites];

    expect(violationsAt(rules, typeMember("grantRole"))).toEqual(["dumb-repository-ports-writes"]);
    expect(violationsAt(rules, typeMember("findOneById"))).toEqual(["dumb-repository-ports-reads"]);
    expect(violationsAt(rules, typeMember("upsertOne"))).toEqual([]);
  });
});

// A synthetic probe never meets a parser, so the checks above need none.
const NO_PARSER = makeFactExtractorFake({});

describe("memberRulesFailingTheirProbe", () => {
  it("passes rules that report their own probes", () => {
    expect(memberRulesFailingTheirProbe(compile([dumbReads, viewHooks]), NO_PARSER)).toEqual([]);
  });

  it("catches a rule whose allowlist has widened to swallow its probe", () => {
    const widened: MemberRule = { ...viewHooks, allow: "^use" };
    expect(
      memberRulesFailingTheirProbe(compile([widened]), NO_PARSER).map((rule) => rule.name),
    ).toEqual(["view-hooks-allowlist"]);
  });

  it("catches a rule whose `in` no longer names its probe's declaration", () => {
    const drifted: MemberRule = { ...dumbReads, in: "NeverMatches$" };
    expect(
      memberRulesFailingTheirProbe(compile([drifted]), NO_PARSER).map((rule) => rule.name),
    ).toEqual(["dumb-repository-ports-reads"]);
  });

  it("catches a rule whose from side no longer selects its probe", () => {
    const drifted: MemberRule = { ...viewHooks, from: "^packages/server/" };
    expect(
      memberRulesFailingTheirProbe(compile([drifted]), NO_PARSER).map((rule) => rule.name),
    ).toEqual(["view-hooks-allowlist"]);
  });

  // A probe with a source is the parser's to satisfy: the snippet must yield a
  // site of the probe's name that the rule reports. The fake stands in for the
  // parser and says what each snippet reads as.
  describe("with a source", () => {
    const INTERSECTION = "export type TodosRepositoryShape = Base & { findOneById(): void };";
    const LITERAL = "export type TodosRepositoryShape = { findOneById(): void };";

    const parser = makeFactExtractorFake({
      // The parser reads the literal's member, and nothing out of the intersection.
      [LITERAL]: {
        specifiers: [],
        bindings: new Map(),
        memberSites: [
          {
            file: "",
            subject: "members",
            name: "findOneById",
            in: "TodosRepositoryShape",
            declares: "type",
          },
        ],
      },
    });

    const sourced = (source: string): MemberRule => ({
      ...dumbReads,
      probe: { from: PORT, name: "findOneById", source },
    });

    it("passes when the parser reads the named site and the rule reports it", () => {
      expect(memberRulesFailingTheirProbe(compile([sourced(LITERAL)]), parser)).toEqual([]);
    });

    it("fails when the parser reads no site of that name — the vacuity a synthetic probe cannot see", () => {
      expect(
        memberRulesFailingTheirProbe(compile([sourced(INTERSECTION)]), parser).map(
          (rule) => rule.name,
        ),
      ).toEqual(["dumb-repository-ports-reads"]);
    });

    it("fails when the parser reads the site but the rule admits it", () => {
      const widened: MemberRule = { ...sourced(LITERAL), allow: "^find" };
      expect(
        memberRulesFailingTheirProbe(compile([widened]), parser).map((rule) => rule.name),
      ).toEqual(["dumb-repository-ports-reads"]);
    });

    it("judges the declaration by what the parser read, not by the probe's own `in`", () => {
      // The synthetic `in` is meaningless once a source is present: the site
      // carries the declaration it was found in.
      const drifted: MemberRule = { ...sourced(LITERAL), in: "NeverMatches$" };
      expect(
        memberRulesFailingTheirProbe(compile([drifted]), parser).map((rule) => rule.name),
      ).toEqual(["dumb-repository-ports-reads"]);
    });
  });
});

describe("compileMemberRules", () => {
  const broken = "^packages/(unclosed";

  it.each([
    ["from", { from: broken }],
    ["fromNot", { fromNot: [broken] }],
    ["in", { in: broken }],
    ["match", { match: broken }],
    ["matchNot", { matchNot: [broken] }],
    ["allow", { allow: broken }],
  ])("refuses an invalid pattern in %s", (field, override) => {
    const compiled = compileMemberRules([{ ...dumbReads, ...override }]);
    expect(Result.isFailure(compiled) && compiled.failure.field).toBe(field);
  });
});
