// Triages the repo's open security alerts once a day: Dependabot (including
// malware) and secret scanning. Code scanning is left out on purpose: it finds
// flaws nobody knows about yet, which belong in a private advisory rather than
// a public issue. An agent reads each new alert against the code and
// decides whether it needs work. Every decision becomes an issue labelled
// `security` that names its alerts in a hidden marker, so no alert is triaged
// twice:
//
// - fix: credible and fixable by an agent, queued with auto:eligible;
// - person: credible, but a person must act (revoke a secret, audit after
//   malware), labelled auto:needs-human;
// - dismiss: not credible or not worth fixing, opened and closed as not
//   planned with the reason. Reopen it, or delete it, to have the alert looked
//   at again.
//
// The alerts stay open on GitHub; this flow never dismisses one.

import { activity, Agent, defineFlow, GitHub, Implement, type Json, printJson, renderPrompt, Repo, Run, RunLog, StepFailed, type WorkItem, Worktree } from '@chernabog/sdk';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Rec from 'effect/Record';
import * as Schema from 'effect/Schema';

const SECURITY_LABEL = 'security';

const AlertKeys = Schema.fromJsonString(Schema.Array(Schema.String));

const alertMarker = (keys: ReadonlyArray<string>) => `<!-- chernabog-security-alerts ${Schema.encodeSync(AlertKeys)(keys)} -->`;

const markedAlerts = (body: string): ReadonlyArray<string> =>
  Option.fromNullishOr(body.match(/<!-- chernabog-security-alerts (\[.*?\]) -->/)).pipe(
    Option.flatMap((match) => Schema.decodeOption(AlertKeys)(match[1])),
    Option.getOrElse((): ReadonlyArray<string> => []),
  );

// The fields this flow reads from GitHub's answers; the rest pass through as JSON.
const RawAlert = Schema.Record(Schema.String, Schema.Json);
const AlertFields = Schema.Struct({ number: Schema.Finite, html_url: Schema.String });
const IssueFields = Schema.Struct({ number: Schema.Finite, body: Schema.OptionFromNullOr(Schema.String) });

const decode = <A>(schema: Schema.Codec<A, Json>, what: string) => (json: Json) =>
  Schema.decodeEffect(schema)(json).pipe(Effect.mapError((issue) => new StepFailed({ step: 'security', message: `${what}: ${issue.message}` })));

type Alert = { readonly key: string; readonly url: string; readonly details: Json };

// A secret alert's value is dropped before anything else sees it: the agent must never repeat it.
const SOURCES = [
  { kind: 'dependabot', path: 'dependabot/alerts', omit: [] },
  { kind: 'secret-scanning', path: 'secret-scanning/alerts', omit: ['secret'] },
] as const;

// Every open alert, by key such as `dependabot/12`, from the first hundred of
// each kind. A source that is off for the repo, or that the token cannot read,
// is logged and left out.
const openAlerts = Effect.gen(function* () {
  const github = yield* GitHub;
  const repo = yield* Repo;
  const alerts: Array<Alert> = [];

  for (const source of SOURCES) {
    const page = yield* github.request('GET', `/repos/${repo.slug}/${source.path}?state=open&per_page=100`, Option.none()).pipe(
      Effect.flatMap(decode(Schema.Array(RawAlert), source.kind)),
      Effect.catch((error) => RunLog.use((log) => log.log(`security: skipped ${source.kind} alerts: ${error.message}`)).pipe(Effect.as([]))),
    );

    for (const raw of page) {
      const fields = yield* decode(AlertFields, source.kind)(raw);
      const details = source.omit.reduce<Readonly<Record<string, Json>>>((alert, key) => Rec.remove(alert, key), raw);

      alerts.push({ key: `${source.kind}/${fields.number}`, url: fields.html_url, details });
    }
  }

  return alerts;
});

// Alerts an earlier run already wrote an issue for, open or closed.
const triagedAlerts = Effect.gen(function* () {
  const github = yield* GitHub;
  const repo = yield* Repo;
  const triaged = new Set<string>();

  for (let page = 1; ; page++) {
    const issues = yield* github
      .request('GET', `/repos/${repo.slug}/issues?labels=${SECURITY_LABEL}&state=all&per_page=100&page=${page}`, Option.none())
      .pipe(Effect.flatMap(decode(Schema.Array(IssueFields), 'issues')));

    for (const issue of issues) for (const key of Option.match(issue.body, { onNone: () => [], onSome: markedAlerts })) triaged.add(key);

    if (issues.length < 100) return triaged;
  }
});

const untriagedAlerts = Effect.gen(function* () {
  const triaged = yield* triagedAlerts;

  return (yield* openAlerts).filter((alert) => !triaged.has(alert.key));
});

// One item for the whole repo while any alert is untriaged; its run takes
// every alert that is still untriaged when it starts.
const trigger = untriagedAlerts.pipe(
  Effect.map((alerts): ReadonlyArray<WorkItem> => {
    if (alerts.length === 0) return [];

    return [{ key: 'security-alerts', title: `Triage ${alerts.length} security alert(s)`, data: { alerts: alerts.map((alert) => alert.key) } }];
  }),
);

const Decision = Schema.Literals(['fix', 'person', 'dismiss']);

const Triage = Schema.Struct({
  issues: Schema.Array(Schema.Struct({ alerts: Schema.Array(Schema.String), decision: Decision, title: Schema.String, body: Schema.String })),
});

type Triage = typeof Triage.Type;

const triageJsonSchema = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      description: 'One entry per issue to write; together they name every alert you were given exactly once',
      items: {
        type: 'object',
        properties: {
          alerts: { type: 'array', items: { type: 'string' }, description: 'The keys of the alerts this issue covers, such as dependabot/12' },
          decision: { type: 'string', enum: ['fix', 'person', 'dismiss'] },
          title: { type: 'string', description: 'The issue title' },
          body: { type: 'string', description: 'The issue body in Markdown' },
        },
        required: ['alerts', 'decision', 'title', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['issues'],
  additionalProperties: false,
} satisfies Json;

const describeAlert = (alert: Alert) => `### ${alert.key}\n\n${alert.url}\n\n\`\`\`json\n${printJson(alert.details)}\n\`\`\``;

// The agent reads the alerts against the base branch, in a read-only checkout, and decides.
const triage = activity(
  'triage',
  Effect.gen(function* () {
    const repo = yield* Repo;
    const run = yield* Run;
    const alerts = yield* untriagedAlerts;

    if (alerts.length === 0) return { issues: [] };

    const worktree = yield* (yield* Worktree).checkout('security-triage', `origin/${repo.baseBranch}`);

    const prompt = yield* renderPrompt('security', {
      repo: repo.slug,
      base: repo.baseBranch,
      alerts: alerts.map(describeAlert).join('\n\n'),
      humanOnly: repo.humanOnly,
      notes: repo.notes,
    });

    const result = yield* (yield* Agent).run({
      cwd: worktree,
      prompt,
      sessionId: Implement.sessionIdFor(run.runId, 'triage'),
      resumePrompt: Option.none(),
      outputSchema: Option.some(triageJsonSchema),
      adapter: Option.none(),
    });

    const answer = yield* Schema.decodeUnknownEffect(Triage)(result.output).pipe(
      Effect.mapError((issue) => new StepFailed({ step: 'triage', message: `agent answer: ${issue.message}` })),
    );

    // Only alerts it was given, each once; any it left out wait for the next run.
    const given = new Set(alerts.map((alert) => alert.key));
    const seen = new Set<string>();

    const issues = answer.issues.flatMap((issue) => {
      const keys = issue.alerts.filter((key) => given.has(key) && !seen.has(key));

      for (const key of keys) seen.add(key);

      if (keys.length === 0) return [];

      return [{ ...issue, alerts: keys }];
    });

    return { issues };
  }),
  Triage,
);

const LABELS: Record<typeof Decision.Type, (labels: { readonly eligible: string; readonly needsHuman: string }) => ReadonlyArray<string>> = {
  fix: (labels) => [SECURITY_LABEL, labels.eligible],
  person: (labels) => [SECURITY_LABEL, labels.needsHuman],
  dismiss: () => [SECURITY_LABEL],
};

// Writes each decision as an issue. Safe to repeat: an alert that already has
// an issue, from an earlier attempt of this step, is not written again.
const writeIssues = (decisions: Triage) =>
  activity(
    'write-issues',
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      const triaged = yield* triagedAlerts;
      const written: Array<string> = [];

      // Creates the label the first time; GitHub answers 422 once it exists.
      yield* github
        .request('POST', `/repos/${repo.slug}/labels`, Option.some({ name: SECURITY_LABEL, color: 'b60205', description: 'Written by the chernabog security flow' }))
        .pipe(Effect.ignore);

      for (const issue of decisions.issues) {
        if (issue.alerts.some((key) => triaged.has(key))) continue;

        const created = yield* github
          .request(
            'POST',
            `/repos/${repo.slug}/issues`,
            Option.some({ title: issue.title, body: `${issue.body}\n\n${alertMarker(issue.alerts)}`, labels: [...LABELS[issue.decision](repo.labels)] }),
          )
          .pipe(Effect.flatMap(decode(IssueFields, 'new issue')));

        if (issue.decision === 'dismiss') {
          yield* github.request('PATCH', `/repos/${repo.slug}/issues/${created.number}`, Option.some({ state: 'closed', state_reason: 'not_planned' }));
        }

        written.push(`#${created.number} ${issue.decision} (${issue.alerts.join(', ')})`);
      }

      return written;
    }),
    Schema.Array(Schema.String),
  );

export default defineFlow({
  trigger,
  gate: Implement.gate,
  concurrency: 1,
  schedule: '23 8 * * *',
  workflow: () =>
    Effect.gen(function* () {
      const written = yield* writeIssues(yield* triage);

      if (written.length === 0) return 'no new security alerts';

      return `wrote ${written.join('; ')}`;
    }),
});
