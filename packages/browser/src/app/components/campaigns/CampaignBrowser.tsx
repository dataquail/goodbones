import { useMemo, useState } from "react";

import type { CampaignCard, CampaignView } from "../../../model/campaigns.js";
import { Detail } from "./Detail.js";
import { Ladder } from "./Ladder.js";
import type { Pick } from "./pick.js";

// The Campaign Browser: the ladder the docs draw, for real. A campaign's
// phases in order, each recognized by its objectives; its sectors standing at
// the first phase with residue for them; the end state last. Hover a phase,
// an objective or a sector and the rest of the ladder says how they relate;
// the pane beside it says what `campaigns` and `check` would.

// The selection in the hash: `<campaign>` alone, or `<campaign>/<kind>:<id>`.
const parseSelection = (
  view: CampaignView,
  text: string | null,
): { campaign: string | null; pick: Pick | null } => {
  if (text === null) return { campaign: null, pick: null };
  const at = text.indexOf("/");
  const campaign = at === -1 ? text : text.slice(0, at);
  if (!view.campaigns.some((one) => one.id === campaign)) return { campaign: null, pick: null };
  if (at === -1) return { campaign, pick: null };
  const rest = text.slice(at + 1);
  const colon = rest.indexOf(":");
  const kind = colon === -1 ? rest : rest.slice(0, colon);
  const id = colon === -1 ? "" : rest.slice(colon + 1);
  const pick: Pick | null =
    kind === "campaign"
      ? { kind: "campaign" }
      : kind === "phase"
        ? { kind: "phase", id }
        : kind === "objective"
          ? { kind: "objective", id }
          : kind === "sector"
            ? { kind: "sector", name: id }
            : null;
  return { campaign, pick };
};

export const selectionText = (campaign: string, pick: Pick | null): string =>
  pick === null
    ? campaign
    : `${campaign}/${pick.kind}${pick.kind === "campaign" ? "" : `:${pick.kind === "sector" ? pick.name : pick.id}`}`;

type Props = {
  readonly view: CampaignView;
  readonly selection: string | null;
  readonly onSelect: (selection: string | null) => void;
};

export const CampaignBrowser = ({ onSelect, selection, view }: Props): React.JSX.Element => {
  const parsed = useMemo(() => parseSelection(view, selection), [view, selection]);
  const campaign: CampaignCard | undefined =
    view.campaigns.find((one) => one.id === parsed.campaign) ?? view.campaigns[0];
  const [hover, setHover] = useState<Pick | null>(null);

  if (campaign === undefined) {
    return <div className="placeholder">This policy declares no campaigns.</div>;
  }
  const selected = parsed.campaign === campaign.id ? parsed.pick : null;
  const pick = (next: Pick | null): void => {
    onSelect(selectionText(campaign.id, next));
  };
  const nudged = view.nudge?.sectors.filter((one) => one.campaign === campaign.id) ?? [];

  return (
    <div className="camp">
      <section className="pane ladder-pane" aria-label="Campaign ladder">
        <div className="pane-head tabs-row">
          {view.campaigns.map((one) => (
            <button
              key={one.id}
              type="button"
              className={one.id === campaign.id ? "tab active" : "tab"}
              onClick={() => {
                onSelect(selectionText(one.id, null));
              }}
              title={one.title ?? one.id}
            >
              <span className="mono">{one.id}</span>
              <span className={`pct ${one.complete ? "good" : one.stalled ? "bad" : ""}`}>
                {Math.round(one.progress * 100)}%
              </span>
            </button>
          ))}
        </div>
        <div className="camp-head">
          <h2>
            {campaign.title ?? campaign.id}
            {campaign.stalled ? <span className="flag bad">stalled</span> : null}
            {campaign.complete ? <span className="flag good">complete</span> : null}
            {campaign.missingLedger ? <span className="flag warn">no ledger</span> : null}
            {!campaign.arithmetic ? <span className="flag bad">ledger arithmetic</span> : null}
          </h2>
          <div
            className="progress"
            title={`${String(Math.round(campaign.progress * 100))}% of the initial holdouts cleared`}
          >
            <div
              className="progress-bar"
              style={{ width: `${String(Math.round(campaign.progress * 100))}%` }}
            />
          </div>
          <div className="muted small">
            {campaign.count} holdout{campaign.count === 1 ? "" : "s"} left
            {campaign.owner === null ? "" : ` · ${campaign.owner}`}
            {campaign.staleAfterDays === null
              ? ""
              : ` · stale after ${String(campaign.staleAfterDays)}d`}
            {" · scope "}
            <span className="mono">{campaign.scope.join(", ")}</span>
            {campaign.perimeter === null ? "" : ` · perimeter ${campaign.perimeter}`}
          </div>
        </div>
        <div className="ladder-scroll">
          <Ladder
            campaign={campaign}
            nudged={new Set(nudged.map((one) => one.sector))}
            hover={hover}
            selected={selected}
            onHover={setHover}
            onPick={pick}
          />
        </div>
        <div className="legend">
          <span className="key defined">defined phase</span>
          <span className="key open">open phase</span>
          <span className="key sector">sector</span>
          <span className="key legacy">legacy</span>
          <span className="key done">done</span>
          <span className="key nudged">touched in the working tree</span>
        </div>
      </section>
      <section className="pane detail-pane" aria-label="Details">
        <Detail
          view={view}
          campaign={campaign}
          shown={hover ?? selected ?? { kind: "campaign" }}
          pinned={hover === null && selected !== null}
          onPick={pick}
        />
      </section>
    </div>
  );
};
