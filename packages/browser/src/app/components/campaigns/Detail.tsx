import type { SectorNudge } from "@goodbones/campaigns";

import type {
  CampaignCard,
  CampaignView,
  ObjectiveCard,
  PhaseCard,
  SectorCard,
} from "../../../model/campaigns.js";
import type { Pick } from "./pick.js";

// What the CLI would say about the thing under the pointer: `campaigns` for
// the campaign, `check` for an objective's ledger against the code, `explain`
// for a sector's files, `campaigns status --changed` for the sectors the
// working tree touches.

type Props = {
  readonly view: CampaignView;
  readonly campaign: CampaignCard;
  readonly shown: Pick;
  readonly pinned: boolean;
  readonly onPick: (pick: Pick | null) => void;
};

// `—` for an objective no sector has entered: neither 0% nor 100%.
const pct = (fraction: number | null): string =>
  fraction === null ? "—" : `${String(Math.round(fraction * 100))}%`;

const when = (iso: string | null): string => {
  if (iso === null) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
};

const at = (position: { file: string; line: number } | null): string =>
  position === null ? "" : `${position.file}:${String(position.line)}`;

export const Detail = ({ campaign, onPick, pinned, shown, view }: Props): React.JSX.Element => (
  <div className="detail">
    <div className="pane-head">
      <span className="eyebrow">{shown.kind}</span>
      {pinned ? (
        <button
          type="button"
          className="small"
          onClick={() => {
            onPick(null);
          }}
        >
          unpin
        </button>
      ) : shown.kind === "campaign" ? null : (
        <span className="hint">click to pin</span>
      )}
    </div>
    {shown.kind === "campaign" ? (
      <CampaignDetail view={view} campaign={campaign} onPick={onPick} />
    ) : shown.kind === "phase" ? (
      <PhaseDetail campaign={campaign} id={shown.id} onPick={onPick} />
    ) : shown.kind === "objective" ? (
      <ObjectiveDetail campaign={campaign} id={shown.id} onPick={onPick} />
    ) : (
      <SectorDetail view={view} campaign={campaign} name={shown.name} onPick={onPick} />
    )}
  </div>
);

const CampaignDetail = ({
  campaign,
  onPick,
  view,
}: {
  view: CampaignView;
  campaign: CampaignCard;
  onPick: Props["onPick"];
}): React.JSX.Element => {
  const nudged = view.nudge?.sectors.filter((one) => one.campaign === campaign.id) ?? [];
  return (
    <>
      <h2>{campaign.title ?? campaign.id}</h2>
      <p className="muted small mono">
        {campaign.id}
        {campaign.position === null ? "" : ` · ${at(campaign.position)}`}
      </p>
      {campaign.why !== null ? (
        <>
          <h3>Why</h3>
          <p className="message">{campaign.why}</p>
        </>
      ) : null}
      {campaign.how !== null ? (
        <>
          <h3>How</h3>
          <p className="message">{campaign.how}</p>
        </>
      ) : null}
      <dl className="facts">
        <dt>progress</dt>
        <dd>
          {pct(campaign.progress)}
          {campaign.steps > 0 ? (
            <span className="muted small"> of the way along {campaign.steps} phases</span>
          ) : null}
        </dd>
        <dt>holdouts left</dt>
        <dd>{campaign.count}</dd>
        <dt>owner</dt>
        <dd>{campaign.owner ?? "—"}</dd>
        <dt>scope</dt>
        <dd className="mono">{campaign.scope.join(", ")}</dd>
        <dt>perimeter</dt>
        <dd>{campaign.perimeter ?? "none: the scope is the one sector"}</dd>
        <dt>stale after</dt>
        <dd>
          {campaign.staleAfterDays === null ? "never" : `${String(campaign.staleAfterDays)} days`}
        </dd>
        <dt>on completion</dt>
        <dd>{campaign.onComplete}</dd>
        <dt>ledgers</dt>
        <dd className={campaign.ledgered ? "good" : "bad"}>
          {campaign.ledgered
            ? `every objective, under ${view.ledgerDir}/${campaign.id}/`
            : "missing: run `architecture objectives clear`"}
        </dd>
        <dt>arithmetic</dt>
        <dd className={campaign.arithmetic ? "good" : "bad"}>
          {campaign.arithmetic ? "holds" : "does not hold"}
        </dd>
        <dt>legacy</dt>
        <dd>
          {campaign.legacy.files} file{campaign.legacy.files === 1 ? "" : "s"} no sector claims
          {campaign.legacy.holdouts > 0 ? `, ${String(campaign.legacy.holdouts)} holdouts` : ""}
        </dd>
        {campaign.shared === null ? null : (
          <>
            <dt>shared</dt>
            <dd>
              {campaign.shared.files} file{campaign.shared.files === 1 ? "" : "s"} every sector
              shares
              {campaign.shared.holdouts > 0 ? `, ${String(campaign.shared.holdouts)} holdouts` : ""}
            </dd>
          </>
        )}
      </dl>
      {campaign.plan.changed.length +
        campaign.plan.unreceipted.length +
        campaign.plan.refined.length >
      0 ? (
        <>
          <h3>Plan</h3>
          <ul className="list">
            {campaign.plan.unreceipted.map((id) => (
              <li key={`u:${id}`} className="bad">
                phase <span className="mono">{id}</span> changed without a concession
              </li>
            ))}
            {campaign.plan.changed.map((id) => (
              <li key={`c:${id}`}>
                phase <span className="mono">{id}</span> changed, with its receipt
              </li>
            ))}
            {campaign.plan.refined.map((id) => (
              <li key={`r:${id}`}>
                open phase refined into <span className="mono">{id}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {campaign.drift.length > 0 ? (
        <>
          <h3>Drift</h3>
          <ul className="list">
            {campaign.drift.map((one) => (
              <li key={one.file} className="bad">
                <span className="mono">{one.file}</span> is claimed by {one.sectors.join(" and ")}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h3>Objectives</h3>
      <ul className="list">
        {campaign.objectives.map((objective) => (
          <li key={objective.id}>
            <button
              type="button"
              className="link mono"
              onClick={() => {
                onPick({ kind: "objective", id: objective.id });
              }}
            >
              {objective.id}
            </button>
            <span className="muted small">
              {" "}
              {objective.measure === null
                ? `${String(objective.count)} left · ${pct(objective.progress)}`
                : `${String(objective.measure.value ?? "?")} ${objective.measure.direction === "down" ? "↓" : "↑"} ${objective.measure.target === null ? "" : `target ${String(objective.measure.target)}`}`}
              {objective.phase === null ? "" : ` · ${objective.phase}`}
            </span>
          </li>
        ))}
      </ul>
      <h3>Sectors</h3>
      <ul className="list compact">
        {campaign.sectors.map((sector) => (
          <li key={sector.name}>
            <button
              type="button"
              className="link mono"
              onClick={() => {
                onPick({ kind: "sector", name: sector.name });
              }}
            >
              {sector.name}
            </button>
            <span className="muted small">
              {" "}
              {sector.done ? "done" : sector.phaseId === null ? "" : `at ${sector.phaseId}`}
              {sector.stalled ? " · stalled" : ""}
            </span>
          </li>
        ))}
      </ul>
      {view.nudge !== null ? (
        <>
          <h3>Working tree</h3>
          {view.nudge.touched.length === 0 ? (
            <p className="muted">No uncommitted change touches the scope.</p>
          ) : nudged.length === 0 ? (
            <p className="muted">
              {view.nudge.touched.length} file(s) changed, none in a sector of this campaign.
            </p>
          ) : (
            <ul className="list">
              {nudged.map((one) => (
                <li key={one.sector}>
                  <button
                    type="button"
                    className="link mono"
                    onClick={() => {
                      onPick({ kind: "sector", name: one.sector });
                    }}
                  >
                    {one.sector}
                  </button>{" "}
                  <NudgeWord nudge={one} />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </>
  );
};

const NudgeWord = ({ nudge }: { nudge: SectorNudge }): React.JSX.Element => (
  <span
    className={`flag ${nudge.verdict === "ok" ? "good" : nudge.verdict === "back" ? "bad" : "warn"}`}
  >
    {nudge.verdict}
    {nudge.ask === "none" ? "" : ` · ${nudge.ask}`}
  </span>
);

const PhaseDetail = ({
  campaign,
  id,
  onPick,
}: {
  campaign: CampaignCard;
  id: string;
  onPick: Props["onPick"];
}): React.JSX.Element | null => {
  const phase: PhaseCard | undefined = campaign.phases.find((one) => one.id === id);
  if (phase === undefined) return null;
  const here = campaign.sectors.filter((one) => one.phase === phase.index && !one.done);
  return (
    <>
      <h2 className="mono">{phase.id}</h2>
      <p className="muted small">
        phase {phase.index + 1} of {campaign.phases.length}
        {phase.defined ? ", defined" : ", open"}
        {phase.attested ? ", attested" : ""}
        {phase.position === null ? "" : ` · ${at(phase.position)}`}
      </p>
      {phase.intent !== null ? <p className="message">“{phase.intent}”</p> : null}
      {!phase.defined ? (
        <p className="muted">
          An open phase carries intent only. It is refined into defined phases as sectors reach it
          and the next step becomes clear.
        </p>
      ) : null}
      {phase.attested ? (
        <p className="muted">
          An attested phase is not detected: no objective sees it done. A sector leaves it when
          someone records that it is, with{" "}
          <code>
            architecture campaigns attest &lt;sector&gt; {phase.id} --reason "…" --campaign{" "}
            {campaign.id}
          </code>
          .
        </p>
      ) : null}
      {phase.onTouch !== null || phase.grows.length > 0 ? (
        <dl className="facts">
          {phase.onTouch !== null ? (
            <>
              <dt>onTouch</dt>
              <dd>{phase.onTouch}</dd>
            </>
          ) : null}
          {phase.grows.length > 0 ? (
            <>
              <dt>grows</dt>
              <dd>
                <span className="mono">{phase.grows.join(", ")}</span>
                <span className="muted small">
                  {" "}
                  — expected to rise here; <code>clear</code> records it, <code>check</code> does
                  not refuse it
                </span>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {phase.concessions > 0 ? (
        <p className="muted small">
          {phase.concessions} recorded change{phase.concessions === 1 ? "" : "s"} to this phase.
        </p>
      ) : null}
      <h3>Objectives</h3>
      <ul className="list">
        {phase.objectives.map((objectiveId) => {
          const objective = campaign.objectives.find((one) => one.id === objectiveId);
          return (
            <li key={objectiveId}>
              <button
                type="button"
                className="link mono"
                onClick={() => {
                  onPick({ kind: "objective", id: objectiveId });
                }}
              >
                {objectiveId}
              </button>
              {objective === undefined ? null : (
                <span className="muted small">
                  {" "}
                  {objective.count} left · {pct(objective.progress)}
                  {objective.prerequisite ? " · prerequisite, met on the shared files" : ""}
                </span>
              )}
            </li>
          );
        })}
        {phase.objectives.length === 0 ? <li className="muted">none</li> : null}
      </ul>
      <h3>Sectors standing here</h3>
      <ul className="list compact">
        {here.map((sector) => (
          <li key={sector.name}>
            <button
              type="button"
              className="link mono"
              onClick={() => {
                onPick({ kind: "sector", name: sector.name });
              }}
            >
              {sector.name}
            </button>
            <span className="muted small">
              {" "}
              {Object.entries(sector.residue)
                .filter(([objective]) => phase.objectives.includes(objective))
                .map(([objective, n]) => `${objective}: ${String(n)}`)
                .join(", ")}
            </span>
          </li>
        ))}
        {here.length === 0 ? <li className="muted">none</li> : null}
      </ul>
    </>
  );
};

const ObjectiveDetail = ({
  campaign,
  id,
  onPick,
}: {
  campaign: CampaignCard;
  id: string;
  onPick: Props["onPick"];
}): React.JSX.Element | null => {
  const objective: ObjectiveCard | undefined = campaign.objectives.find((one) => one.id === id);
  if (objective === undefined) return null;
  const measure = objective.measure;
  return (
    <>
      <h2 className="mono">
        {objective.id}
        {objective.prerequisite ? <span className="flag">prerequisite</span> : null}
      </h2>
      <p className="muted small">
        holdout: {objective.holdout}
        {objective.phase === null
          ? objective.prerequisite
            ? " · named by no phase: a standing rule of the shared files"
            : " · in window everywhere"
          : ` · phase ${objective.phase}`}
        {objective.position === null ? "" : ` · ${at(objective.position)}`}
      </p>
      {objective.intent !== null ? <p className="message">“{objective.intent}”</p> : null}
      <p className={objective.intent === null ? "message" : "muted"}>{objective.message}</p>
      {objective.prerequisite ? (
        <p className="muted">
          Read over the shared files and ledgered there, under{" "}
          <button
            type="button"
            className="link mono"
            onClick={() => {
              onPick({ kind: "sector", name: "shared" });
            }}
          >
            shared
          </button>
          .
          {objective.phase === null
            ? ""
            : objective.waiting.length === 0
              ? ` No sector stands at ${objective.phase} waiting on it.`
              : ` Held at ${objective.phase} until it is met: ${objective.waiting.join(", ")}.`}
        </p>
      ) : null}
      {measure === null ? (
        <>
          <div
            className="progress"
            title={
              objective.progress === null
                ? "no sector has entered this objective's window yet"
                : `${pct(objective.progress)} of the initial holdouts cleared`
            }
          >
            <div className="progress-bar" style={{ width: pct(objective.progress ?? 0) }} />
          </div>
          <dl className="facts">
            <dt>left</dt>
            <dd className={objective.count === 0 ? "good" : ""}>{objective.count}</dd>
            <dt>initial</dt>
            <dd>
              {objective.initial}
              {objective.allowed > 0 ? ` +${String(objective.allowed)} conceded` : ""}
            </dd>
            <dt>cleared</dt>
            <dd>{objective.cleared}</dd>
            <dt>closed</dt>
            <dd>{objective.closed}</dd>
            <dt>last cleared</dt>
            <dd>{when(objective.lastCleared)}</dd>
            <dt>concessions</dt>
            <dd>{objective.concessions}</dd>
            <dt>ledger</dt>
            <dd className={objective.ledgered ? "good" : "bad"}>
              {objective.ledgered ? "present" : "missing"}
            </dd>
          </dl>
        </>
      ) : (
        <dl className="facts">
          <dt>now</dt>
          <dd>{measure.value ?? "unmeasured"}</dd>
          <dt>recorded</dt>
          <dd>{measure.recorded ?? "not yet"}</dd>
          <dt>target</dt>
          <dd>{measure.target ?? "standing: only ratchets"}</dd>
          <dt>direction</dt>
          <dd>{measure.direction === "down" ? "lower is better" : "higher is better"}</dd>
          <dt>tolerance</dt>
          <dd>{measure.tolerance}</dd>
          <dt>progress</dt>
          <dd>{pct(objective.progress)}</dd>
          <dt>ledger</dt>
          <dd className={objective.ledgered ? "good" : "bad"}>
            {objective.ledgered ? "present" : "missing"}
          </dd>
        </dl>
      )}
      <h3>By sector</h3>
      {objective.sectors.length === 0 ? (
        <p className="muted">no sector is in this objective's window</p>
      ) : null}
      {objective.sectors.map((sector) => (
        <div key={sector.sector} className="sector-block">
          <div className="sector-row">
            <button
              type="button"
              className="link mono"
              onClick={() => {
                onPick({ kind: "sector", name: sector.sector });
              }}
            >
              {sector.sector}
            </button>
            <span className="muted small">
              {" "}
              {sector.measure === null
                ? `${String(sector.count)} left`
                : `${String(sector.measure.value ?? "?")} now, ${String(sector.measure.recorded ?? "?")} recorded, ${sector.measure.standing}`}
              {sector.unrecorded ? " · unrecorded" : ""}
              {sector.initial === null
                ? ""
                : ` · ${String(sector.initial)} initially, ${String(sector.cleared ?? 0)} cleared`}
            </span>
          </div>
          {sector.new.length > 0 ? (
            <ul className="list compact">
              {sector.new.map((entry) => (
                <li key={`new:${entry}`} className="bad mono small">
                  + {entry} <span className="muted">(not in the ledger)</span>
                </li>
              ))}
            </ul>
          ) : null}
          {sector.stale.length > 0 ? (
            <ul className="list compact">
              {sector.stale.map((entry) => (
                <li key={`stale:${entry}`} className="good mono small">
                  − {entry} <span className="muted">(cleared, run `objectives clear`)</span>
                </li>
              ))}
            </ul>
          ) : null}
          {sector.holdouts.length > 0 ? (
            <details>
              <summary className="muted small">{sector.holdouts.length} in the ledger</summary>
              <ul className="list compact">
                {sector.holdouts.map((entry) => (
                  <li key={entry} className="mono small">
                    {entry}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ))}
    </>
  );
};

const SectorDetail = ({
  campaign,
  name,
  onPick,
  view,
}: {
  view: CampaignView;
  campaign: CampaignCard;
  name: string;
  onPick: Props["onPick"];
}): React.JSX.Element | null => {
  const sector: SectorCard | undefined = campaign.sectors.find((one) => one.name === name);
  if (sector === undefined) return null;
  const nudge = view.nudge?.sectors.find(
    (one) => one.campaign === campaign.id && one.sector === name,
  );
  return (
    <>
      <h2 className="mono">
        {sector.name}
        {sector.legacy ? <span className="flag warn">legacy</span> : null}
        {sector.shared ? <span className="flag">shared</span> : null}
        {sector.done ? <span className="flag good">done</span> : null}
        {sector.stalled ? <span className="flag bad">stalled</span> : null}
      </h2>
      {sector.legacy ? (
        <p className="muted">What no sector has claimed. It stands at the first phase.</p>
      ) : null}
      {sector.shared ? (
        <p className="muted">
          What every sector shares. It stands on no phase; an objective read over it is a
          prerequisite, and a phase naming one holds every sector until it is met here.
        </p>
      ) : null}
      <dl className="facts">
        <dt>phase</dt>
        <dd>
          {sector.done
            ? "end state"
            : sector.shared
              ? "none"
              : (sector.phaseId ?? (campaign.phases.length === 0 ? "standing" : "—"))}
        </dd>
        <dt>reached</dt>
        <dd>
          {sector.reached ?? "not placed by `clear` yet"}
          {sector.since === null ? "" : ` since ${when(sector.since)}`}
        </dd>
        <dt>files</dt>
        <dd>{sector.files.length}</dd>
        {sector.marker !== null ? (
          <>
            <dt>marker</dt>
            <dd className="mono">{sector.marker}</dd>
          </>
        ) : null}
        <dt>roots</dt>
        <dd className="mono">{sector.roots.length === 0 ? "—" : sector.roots.join(", ")}</dd>
      </dl>
      <h3>Residue</h3>
      <ul className="list">
        {campaign.objectives.map((objective) => {
          const count = sector.residue[objective.id] ?? sector.counts[objective.id];
          const value = sector.values[objective.id];
          return (
            <li key={objective.id}>
              <button
                type="button"
                className="link mono"
                onClick={() => {
                  onPick({ kind: "objective", id: objective.id });
                }}
              >
                {objective.id}
              </button>
              <span className={`muted small ${(count ?? 0) > 0 ? "" : "good"}`}>
                {" "}
                {objective.measure !== null
                  ? value === undefined
                    ? "unmeasured"
                    : `${String(value)}${objective.measure.target === null ? "" : ` → ${String(objective.measure.target)}`}`
                  : count === undefined
                    ? "not in window"
                    : `${String(count)} left`}
                {objective.prerequisite && count !== undefined && !sector.shared
                  ? " · a prerequisite: the shared files' to meet"
                  : ""}
              </span>
            </li>
          );
        })}
      </ul>
      {nudge !== undefined ? (
        <>
          <h3>Working tree</h3>
          <p>
            <NudgeWord nudge={nudge} />{" "}
            <span className="muted small">
              direction {nudge.direction} · onTouch {nudge.onTouch}
              {nudge.judged.index === nudge.phase.index
                ? ""
                : ` · judged at ${nudge.judged.id ?? "done"}, where the diff found it`}
            </span>
          </p>
          {nudge.entered.some((one) => one.count > 0) ? (
            <p className="muted small">
              Now counted, not growth:{" "}
              {nudge.entered
                .filter((one) => one.count > 0)
                .map((one) => `${one.objective} ${String(one.count)}`)
                .join(" · ")}
            </p>
          ) : null}
          {nudge.holdouts.sector.length > 0 ? (
            <ul className="list compact">
              {nudge.holdouts.sector.map((one) => (
                <li key={one.objective} className="small">
                  <span className="mono">{one.objective}</span>
                  <div className="muted">{one.message}</div>
                </li>
              ))}
            </ul>
          ) : null}
          {nudge.holdouts.shown.length > 0 ? (
            <ul className="list compact">
              {nudge.holdouts.shown.map((one) => (
                <li key={`${one.file}:${one.subject ?? ""}`} className="small">
                  <span className="mono">
                    {one.file}
                    {one.line === null ? "" : `:${String(one.line)}`}
                  </span>
                  <div className="muted">{one.message}</div>
                </li>
              ))}
              {nudge.holdouts.touched > nudge.holdouts.shown.length ? (
                <li className="muted small">
                  … {nudge.holdouts.touched - nudge.holdouts.shown.length} more in the files touched
                </li>
              ) : null}
            </ul>
          ) : null}
          {nudge.measures.some((one) => one.before !== one.after || one.back) ? (
            <ul className="list compact">
              {nudge.measures
                .filter((one) => one.before !== one.after || one.back)
                .map((one) => (
                  <li key={one.objective} className="small">
                    <span className="mono">{one.objective}</span>{" "}
                    {one.before === null ? "unrecorded" : String(one.before)} →{" "}
                    {one.after === null ? "no number" : String(one.after)}
                    {one.tolerance === 0 ? "" : ` (tolerance ${String(one.tolerance)})`}
                    {one.back ? (
                      <span className="flag bad">back</span>
                    ) : one.conceded ? (
                      <span className="flag warn">conceded</span>
                    ) : one.grows ? (
                      <span className="flag">
                        {nudge.shared
                          ? "measured, not held"
                          : `grows in ${nudge.judged.id ?? "this phase"}`}
                      </span>
                    ) : null}
                  </li>
                ))}
            </ul>
          ) : null}
          {nudge.conceded.length > 0 ? (
            <p className="muted small">Conceded on this branch: {nudge.conceded.join(" · ")}</p>
          ) : null}
          {nudge.prerequisites.some((one) => one.count > 0) ? (
            <>
              <p className="muted small">
                Prerequisites, which hold every sector at the phase that names them:
              </p>
              <ul className="list compact">
                {nudge.prerequisites
                  .filter((one) => one.count > 0)
                  .map((one) => (
                    <li key={one.objective} className="small">
                      <span className="mono">{one.objective}</span> {one.count}
                      {one.phase === null
                        ? " — named by no phase"
                        : ` — ${one.phase}: ${one.waiting.length === 0 ? "no sector stands there yet" : one.waiting.join(", ")}`}
                    </li>
                  ))}
              </ul>
            </>
          ) : null}
          {nudge.belongsInSector.length > 0 ? (
            <p className="bad small">
              Added inside the scope, in no sector: {nudge.belongsInSector.join(", ")}
            </p>
          ) : null}
        </>
      ) : null}
      {sector.attested.length > 0 ? (
        <>
          <h3>Attestations</h3>
          <ul className="list">
            {sector.attested.map((one) => (
              <li key={`${one.phase}:${one.at}`}>
                <span className="mono">{one.phase}</span> — {one.reason}
                <div className="muted small">
                  {one.by}, {when(one.at)}
                  {one.evidence === undefined ? "" : ` · ${one.evidence}`}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {sector.notes.length > 0 ? (
        <>
          <h3>Notes</h3>
          <ul className="list">
            {sector.notes.map((one) => (
              <li key={`${one.at}:${one.by}`}>
                {one.text}
                <div className="muted small">
                  {one.by}, {when(one.at)}
                  {one.phase === null ? "" : ` · at ${one.phase}`}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h3>Holdouts</h3>
      {sector.hits.length === 0 ? (
        <p className="good">none firing</p>
      ) : (
        <ul className="list compact">
          {sector.hits.slice(0, 80).map((hit) => (
            <li key={`${hit.objective}:${hit.entry}`} className="small">
              <span className="mono">
                {hit.file}
                {hit.line === null ? "" : `:${String(hit.line)}`}
              </span>
              <span className="muted">
                {" "}
                {hit.objective}
                {hit.subject === null ? "" : ` · ${hit.subject}`}
              </span>
            </li>
          ))}
          {sector.hits.length > 80 ? (
            <li className="muted">… {sector.hits.length - 80} more</li>
          ) : null}
        </ul>
      )}
      <details>
        <summary className="muted small">{sector.files.length} files</summary>
        <ul className="list compact">
          {sector.files.map((file) => (
            <li key={file} className="mono small">
              {file}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
};
