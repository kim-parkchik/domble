/**
 * グラフの部品（グラフの画面。ライブラリを使わず SVG と HTML で描く）
 *  - ColumnLineChart：縦棒（グループ）と折れ線を1つの軸（円）で。月などの区切りごとに、ポインタ・キーボードで値を出す
 *  - HBarList：横棒の一覧（内訳。値と割合を棒の先に）
 *  - ChartLegend：凡例（棒は四角、線は短い線）
 * 色は CSS の --series-1〜3（色覚の違いでも見分けられることを確かめた並び）と、前年など目立たせない線の --series-muted。数字は表でも出す
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { yen } from "../../lib/format";
import { niceTicks, tickLabel } from "../../lib/charts";

export interface ChartSeries {
  key: string;
  label: string;
  /** CSS の色（var(--series-1) など） */
  color: string;
  values: number[];
}

/** 要素の幅（ResizeObserver。印刷では SVG が viewBox ごと縮む） */
const useWidth = (fallback = 720) => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
};

/** 基線側は角を立て、値の側だけ 4px 丸めた棒 */
const barPath = (x: number, w: number, y0: number, y1: number) => {
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return "";
  const r = Math.min(4, h, w / 2);
  const up = y1 < y0;
  const t = y1;
  return up
    ? `M${x},${y0}V${t + r}Q${x},${t} ${x + r},${t}H${x + w - r}Q${x + w},${t} ${x + w},${t + r}V${y0}Z`
    : `M${x},${y0}V${t - r}Q${x},${t} ${x + r},${t}H${x + w - r}Q${x + w},${t} ${x + w},${t - r}V${y0}Z`;
};

export const ChartLegend = ({ bars = [], lines = [] }: { bars?: ChartSeries[]; lines?: ChartSeries[] }) => (
  <ul className="chart-legend">
    {bars.map((s) => <li key={s.key}><span className="chart-key-box" style={{ background: s.color }} />{s.label}</li>)}
    {lines.map((s) => <li key={s.key}><span className="chart-key-line" style={{ background: s.color }} />{s.label}</li>)}
  </ul>
);

/**
 * 縦棒（グループ）と折れ線。categories の数と各系列の values の数は同じ
 * 凡例は2系列以上のときだけ出す（1系列は見出しが名前）
 */
export const ColumnLineChart = ({ label, categories, bars = [], lines = [], height = 240 }: {
  label: string; categories: string[]; bars?: ChartSeries[]; lines?: ChartSeries[]; height?: number;
}) => {
  const { ref, width } = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const all = [...bars, ...lines].flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
  const m = { top: 10, right: 12, bottom: 26, left: 52 };
  const plotW = width - m.left - m.right;
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const y = (v: number) => m.top + ((hi - v) / (hi - lo || 1)) * height;
  const band = plotW / Math.max(1, categories.length);
  const cx = (i: number) => m.left + band * i + band / 2;
  const gap = 2;
  const barW = bars.length ? Math.min(24, (band * 0.72 - gap * (bars.length - 1)) / bars.length) : 0;
  const groupW = bars.length * barW + gap * (bars.length - 1);
  const series = [...bars, ...lines];
  // 値の箱は、選んだ区切りの横（右に入らなければ左）に出し、棒や線を隠さない
  const tipRight = active !== null && cx(active) + band / 2 + 190 < width;
  const tipX = active === null ? 0 : tipRight ? cx(active) + band / 2 + 6 : cx(active) - band / 2 - 6;

  return (
    <div className="chart" ref={ref}>
      {series.length > 1 && <ChartLegend bars={bars} lines={lines} />}
      <svg role="img" aria-label={label} width="100%" viewBox={`0 0 ${width} ${height + m.top + m.bottom}`} onMouseLeave={() => setActive(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} className={t === 0 ? "chart-base" : "chart-grid"} />
            <text x={m.left - 6} y={y(t)} dy="0.35em" textAnchor="end" className="chart-tick">{tickLabel(t, step)}</text>
          </g>
        ))}
        {active !== null && <rect x={m.left + band * active} y={m.top} width={band} height={height} className="chart-hover" />}
        {bars.map((s, k) => (
          <g key={s.key} fill={s.color}>
            {s.values.map((v, i) => {
              const x = cx(i) - groupW / 2 + k * (barW + gap);
              const d = barPath(x, barW, y(0), y(v));
              return d ? <path key={i} d={d} /> : null;
            })}
          </g>
        ))}
        {lines.map((s) => (
          <g key={s.key}>
            <path d={s.values.map((v, i) => `${i ? "L" : "M"}${cx(i)},${y(v)}`).join("")} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {s.values.map((v, i) => <circle key={i} cx={cx(i)} cy={y(v)} r={4} fill={s.color} className="chart-dot" />)}
          </g>
        ))}
        {categories.map((c, i) => (
          <text key={c} x={cx(i)} y={height + m.top + 18} textAnchor="middle" className="chart-tick">{c}</text>
        ))}
        {/* 区切りごとの当たり（棒より広い）。キーボードでも選べる */}
        {categories.map((c, i) => (
          <rect
            key={c} x={m.left + band * i} y={m.top} width={band} height={height} className="chart-hit" tabIndex={0}
            aria-label={`${c}：${series.map((s) => `${s.label} ${yen(s.values[i])}円`).join("、")}`}
            onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}
          />
        ))}
      </svg>
      {active !== null && (
        <div className="chart-tip" style={{ left: tipX, transform: tipRight ? "none" : "translateX(-100%)" }} aria-hidden>
          <div className="chart-tip-head">{categories[active]}</div>
          {series.map((s) => (
            <div key={s.key} className="chart-tip-row">
              <span className="chart-key-line" style={{ background: s.color }} />
              <b className={s.values[active] < 0 ? "negative" : undefined}>{yen(s.values[active])}円</b>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export interface HBarItem {
  key: string;
  label: string;
  amount: number;
  /** 割合（%） */
  share: number | null;
  /** 棒の色（そのほかは目立たせない） */
  color: string;
  note?: ReactNode;
}

/** 横棒の一覧。いちばん大きい額を棒いっぱいにする。マイナスの行は棒を描かずに額だけ */
export const HBarList = ({ label, items }: { label: string; items: HBarItem[] }) => {
  const max = Math.max(1, ...items.map((i) => i.amount));
  return (
    <ol className="hbar-list" aria-label={label}>
      {items.map((i) => (
        <li key={i.key}>
          <span className="hbar-label" title={i.label}>{i.label}{i.note}</span>
          <span className="hbar-track">
            {i.amount > 0 && <span className="hbar" style={{ width: `${(i.amount / max) * 100}%`, background: i.color }} />}
          </span>
          <span className={`hbar-value${i.amount < 0 ? " negative" : ""}`}>
            {yen(i.amount)}円{i.share !== null && <small>{i.share.toFixed(1)}%</small>}
          </span>
        </li>
      ))}
    </ol>
  );
};
