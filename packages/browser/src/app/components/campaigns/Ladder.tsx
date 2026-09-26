import type { CampaignCard, ObjectiveCard, SectorCard } from "../../../model/campaigns.js";
import type { Pick } from "./pick.js";

// The ladder, drawn: one column per phase with its objectives beneath, an end
// column, and a lane of sectors each standing in the column of its phase.
// Objectives no phase names — every objective of a campaign without phases —
// stand in a first "standing" column, in window everywhere.

const COL = 168;
const GAP = 14;
const X0 = 16;
const PHASE_Y = 14;
const PHASE_H = 52;
const CHIP_H = 24;
const CHIP_GAP = 6;
const SECTOR_H = 28;
const SECTOR_GAP = 8;

type Column =
  | { readonly kind: "standing" }
  | { readonly kind: "phase"; readonly index: number }
  | { readonly kind: "end" };

type Props = {
  readonly campaign: CampaignCard;
  readonly nudged: ReadonlySet<string>;
  readonly hover: Pick | null;
  readonly selected: Pick | null;
  readonly onHover: (pick: Pick | null) => void;
  readonly onPick: (pick: Pick | null) => void;
};

const same = (a: Pick | null, b: Pick): boolean =>
  a !== null &&
  a.kind === b.kind &&
  (a.kind === "campaign" ||
    (a.kind === "sector" && b.kind === "sector"
      ? a.name === b.name
      : (a as { id?: string }).id === (b as { id?: string }).id));

export const columnsOf = (campaign: CampaignCard): ReadonlyArray<Column> => {
  const standing = campaign.objectives.some((one) => one.phase === null);
  return [
    ...(standing || campaign.phases.length === 0 ? [{ kind: "standing" } as const] : []),
    ...campaign.phases.map((_, index) => ({ kind: "phase", index }) as const),
    { kind: "end" } as const,
  ];
};

// Which column a sector stands in.
export const columnOfSector = (
  campaign: CampaignCard,
  columns: ReadonlyArray<Column>,
  sector: SectorCard,
): number => {
  if (sector.done) return columns.length - 1;
  if (campaign.phases.length === 0) return 0;
  const at = columns.findIndex((one) => one.kind === "phase" && one.index === sector.phase);
  return at === -1 ? 0 : at;
};

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const scalarLabel = (objective: ObjectiveCard): string => {
  const measure = objective.measure;
  if (measure === null) return String(objective.count);
  const value = measure.value === null ? "?" : String(measure.value);
  return measure.target === null ? value : `${value}→${String(measure.target)}`;
};

export const Ladder = ({
  campaign,
  hover,
  nudged,
  onHover,
  onPick,
  selected,
}: Props): React.JSX.Element => {
  const columns = columnsOf(campaign);
  const focus = hover ?? selected;
  const x = (column: number): number => X0 + column * (COL + GAP);
  const objectivesIn = (column: Column): ReadonlyArray<ObjectiveCard> =>
    column.kind === "standing"
      ? campaign.objectives.filter((one) => one.phase === null)
      : column.kind === "phase"
        ? campaign.objectives.filter((one) => one.phase === campaign.phases[column.index]?.id)
        : [];
  const maxChips = Math.max(1, ...columns.map((column) => objectivesIn(column).length));
  const laneY = PHASE_Y + PHASE_H + 14 + maxChips * (CHIP_H + CHIP_GAP) + 18;
  const placed = campaign.sectors.map((sector) => ({
    sector,
    column: columnOfSector(campaign, columns, sector),
  }));
  const rowsIn = new Map<number, number>();
  const withRows = placed.map((one) => {
    const row = rowsIn.get(one.column) ?? 0;
    rowsIn.set(one.column, row + 1);
    return { ...one, row };
  });
  const maxRows = Math.max(1, ...rowsIn.values());
  const laneH = maxRows * (SECTOR_H + SECTOR_GAP) + 12;
  const width = x(columns.length) + 8;
  const height = laneY + laneH + 24;

  // What the focus relates to.
  const focusObjective =
    focus?.kind === "objective"
      ? campaign.objectives.find((one) => one.id === focus.id)
      : undefined;
  const focusPhaseIndex =
    focus?.kind === "phase" ? campaign.phases.findIndex((one) => one.id === focus.id) : -1;
  const focusSector =
    focus?.kind === "sector" ? campaign.sectors.find((one) => one.name === focus.name) : undefined;
  const sectorLit = (sector: SectorCard): boolean =>
    focusObjective !== undefined
      ? (sector.residue[focusObjective.id] ?? sector.counts[focusObjective.id] ?? 0) > 0
      : focusPhaseIndex !== -1
        ? sector.phase === focusPhaseIndex && !sector.done
        : focusSector !== undefined
          ? focusSector.name === sector.name
          : false;
  const objectiveLit = (objective: ObjectiveCard): boolean =>
    focusSector !== undefined
      ? (focusSector.residue[objective.id] ?? 0) > 0
      : focusPhaseIndex !== -1
        ? objective.phase === campaign.phases[focusPhaseIndex]?.id
        : focusObjective !== undefined
          ? focusObjective.id === objective.id
          : false;
  const phaseLit = (index: number): boolean =>
    focusSector !== undefined
      ? focusSector.phase === index && !focusSector.done
      : focusObjective !== undefined
        ? focusObjective.phase === campaign.phases[index]?.id
        : focusPhaseIndex === index;
  const dimmed = focus !== null && focus.kind !== "campaign";

  return (
    <svg
      className={`ladder ${dimmed ? "focused" : ""}`}
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      role="img"
      aria-label={`Campaign ${campaign.id}: ${String(campaign.phases.length)} phases, ${String(campaign.sectors.length)} sectors`}
      onMouseLeave={() => {
        onHover(null);
      }}
    >
      <defs>
        <marker
          id="ladder-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" className="arrowhead" />
        </marker>
      </defs>

      {columns.map((column, i) => {
        const cx = x(i);
        const objectives = objectivesIn(column);
        if (column.kind === "end") {
          const done = campaign.sectors.filter((one) => one.done).length;
          return (
            <g key="end" className={`column end ${campaign.complete ? "lit" : ""}`}>
              <rect x={cx} y={PHASE_Y} width={COL} height={PHASE_H} rx="8" className="phase end" />
              <text x={cx + 12} y={PHASE_Y + 19} className="eyebrow end-text">
                THE END
              </text>
              <text x={cx + 12} y={PHASE_Y + 38} className="phase-name end-text">
                end state
              </text>
              <text x={cx + 12} y={PHASE_Y + PHASE_H + 20} className="small muted">
                {done} of {campaign.sectors.length} sectors there
              </text>
            </g>
          );
        }
        const phase = column.kind === "phase" ? campaign.phases[column.index] : undefined;
        const lit =
          column.kind === "phase"
            ? phaseLit(column.index)
            : focus?.kind === "objective" && focusObjective?.phase === null;
        const pick: Pick | null = phase === undefined ? null : { kind: "phase", id: phase.id };
        return (
          <g
            key={column.kind === "phase" ? `phase:${String(column.index)}` : "standing"}
            className={`column ${lit ? "lit" : ""}`}
          >
            <g
              className={`phase-box ${phase === undefined ? "standing" : phase.defined ? "defined" : "open"} ${pick !== null && same(selected, pick) ? "selected" : ""}`}
              onMouseEnter={() => {
                onHover(pick);
              }}
              onClick={() => {
                onPick(pick);
              }}
            >
              <rect x={cx} y={PHASE_Y} width={COL} height={PHASE_H} rx="8" className="phase" />
              <text x={cx + 12} y={PHASE_Y + 19} className="eyebrow">
                {phase === undefined || column.kind !== "phase"
                  ? "STANDING"
                  : phase.defined
                    ? `PHASE ${String(column.index + 1)}`
                    : "OPEN"}
                {phase?.attested === true ? " · ATTESTED" : ""}
              </text>
              <text x={cx + 12} y={PHASE_Y + 38} className="phase-name">
                {phase === undefined ? "in window everywhere" : truncate(phase.id, 20)}
              </text>
              {phase !== undefined ? (
                <text x={cx + COL - 10} y={PHASE_Y + 38} className="phase-count" textAnchor="end">
                  {phase.sectors}
                </text>
              ) : null}
            </g>
            {i < columns.length - 1 ? (
              <line
                x1={cx + COL + 1}
                y1={PHASE_Y + PHASE_H / 2}
                x2={cx + COL + GAP - 1}
                y2={PHASE_Y + PHASE_H / 2}
                className="connector"
                markerEnd="url(#ladder-arrow)"
              />
            ) : null}
            {phase !== undefined && !phase.defined && phase.intent !== null ? (
              <text x={cx + 12} y={PHASE_Y + PHASE_H + 20} className="intent">
                “{truncate(phase.intent, 26)}”
              </text>
            ) : null}
            {objectives.map((objective, j) => {
              const y =
                PHASE_Y +
                PHASE_H +
                14 +
                j * (CHIP_H + CHIP_GAP) +
                (phase !== undefined && !phase.defined ? 14 : 0);
              const objectivePick: Pick = { kind: "objective", id: objective.id };
              return (
                <g
                  key={objective.id}
                  className={`chip-box ${objectiveLit(objective) ? "lit" : ""} ${objective.complete ? "complete" : ""} ${same(selected, objectivePick) ? "selected" : ""} ${objective.ledgered ? "" : "unledgered"}`}
                  onMouseEnter={() => {
                    onHover(objectivePick);
                  }}
                  onClick={() => {
                    onPick(objectivePick);
                  }}
                >
                  <rect x={cx + 4} y={y} width={COL - 8} height={CHIP_H} rx="12" className="chip" />
                  <text x={cx + 14} y={y + 16} className="chip-text mono">
                    {truncate(objective.id, 18)}
                  </text>
                  <text x={cx + COL - 14} y={y + 16} className="chip-count" textAnchor="end">
                    {scalarLabel(objective)}
                  </text>
                  <title>
                    {objective.message}
                    {objective.measure === null
                      ? ` — ${String(objective.count)} holdout(s), ${String(Math.round(objective.progress * 100))}% cleared`
                      : ` — ${String(objective.measure.value ?? "?")} now, target ${String(objective.measure.target ?? "none")}`}
                  </title>
                </g>
              );
            })}
          </g>
        );
      })}

      <line x1={X0} y1={laneY - 8} x2={width - 8} y2={laneY - 8} className="rule" />
      <text x={X0} y={laneY - 14} className="label">
        Sectors
      </text>
      <text x={X0 + 60} y={laneY - 14} className="small muted">
        holdouts left
      </text>
      {columns.map((_, i) => (
        <rect key={i} x={x(i)} y={laneY} width={COL} height={laneH} rx="8" className="lane" />
      ))}
      {withRows.map(({ column, row, sector }) => {
        const cx = x(column) + 4;
        const cy = laneY + 6 + row * (SECTOR_H + SECTOR_GAP);
        const left = Object.entries(sector.residue).reduce((sum, [, n]) => sum + n, 0);
        const pick: Pick = { kind: "sector", name: sector.name };
        const kind = sector.done ? "done" : sector.legacy ? "legacy" : "sector";
        return (
          <g
            key={sector.name}
            className={`sector-box ${kind} ${sectorLit(sector) ? "lit" : ""} ${same(selected, pick) ? "selected" : ""} ${nudged.has(sector.name) ? "nudged" : ""} ${sector.stalled ? "stalled" : ""}`}
            onMouseEnter={() => {
              onHover(pick);
            }}
            onClick={() => {
              onPick(pick);
            }}
          >
            <rect x={cx} y={cy} width={COL - 8} height={SECTOR_H} rx="6" className="sector" />
            <text x={cx + 10} y={cy + 19} className="sector-name mono">
              {truncate(sector.name, 16)}
            </text>
            <text x={cx + COL - 18} y={cy + 19} className="sector-count" textAnchor="end">
              {sector.done ? "done" : sector.stalled ? `${String(left)} ⏸` : String(left)}
            </text>
            <title>
              {sector.name}: {String(sector.files.length)} files
              {sector.phaseId === null ? "" : `, at ${sector.phaseId}`}
              {sector.stalled ? ", stalled" : ""}
            </title>
          </g>
        );
      })}
      {campaign.sectors.length === 0 ? (
        <text x={X0 + 12} y={laneY + 24} className="small muted">
          no sectors
        </text>
      ) : null}
    </svg>
  );
};
