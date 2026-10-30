import { useEffect, useRef } from "react";
import { ADJUSTMENT_PERIOD } from "../lib/accounting";

export { ADJUSTMENT_PERIOD };

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const PERIODS = [...MONTHS, ADJUSTMENT_PERIOD];

interface Props {
  from: number;
  to: number;
  onChange: (from: number, to: number) => void;
}

/**
 * 集計・帳簿の画面の期間（仕訳日記帳・総勘定元帳・残高試算表）：帳簿入力と同じ月のボタンに「決算整理前」（1月〜12月）を添える。
 * 1月〜12月 = 決算整理前、1月〜決算整理 = 決算整理後（通期）、決算整理だけ = 決算整理仕訳だけ
 */
export const PeriodTabs = ({ from, to, onChange }: Props) => (
  <div className="period-tabs">
    <MonthTabs from={from} to={to} onChange={onChange} />
    <button className={`link-btn${from === 1 && to === 12 ? " on" : ""}`} onClick={() => onChange(1, 12)} title="1月〜12月（決算整理仕訳を含まない）">決算整理前</button>
  </div>
);

/** 期間の表示名（1〜12 = 月、13 = 決算整理） */
export const periodLabel = (p: number) => (p === ADJUSTMENT_PERIOD ? "決算整理" : `${p}月`);

/**
 * 期間のボタン（帳簿用）。1〜12月と、12月のあとの「決算整理」（年度末の決算整理仕訳）。
 * クリックでその期間だけ、Shift + クリックかドラッグで期間をまたいだ範囲、「全期間」で 1月〜決算整理
 */
export const MonthTabs = ({ from, to, onChange }: Props) => {
  // ドラッグの起点（押している間だけ）
  const anchor = useRef<number | null>(null);
  useEffect(() => {
    const up = () => {
      anchor.current = null;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);
  const range = (a: number, b: number) => onChange(Math.min(a, b), Math.max(a, b));
  const all = from === 1 && to === ADJUSTMENT_PERIOD;

  return (
    <div className="month-tabs" role="tablist" aria-label="期間（Shift + クリックかドラッグで複数の期間）">
      <button role="tab" aria-selected={all} className={`all${all ? " on" : ""}`} onClick={() => onChange(1, ADJUSTMENT_PERIOD)}>全期間</button>
      {PERIODS.map((p) => {
        const on = p >= from && p <= to;
        // 選んだ範囲を1本の帯に見せるため、両端だけ角を丸める
        const edge = on ? `${p === from ? " first" : ""}${p === to ? " last" : ""}` : "";
        return (
          <button
            key={p}
            role="tab"
            aria-selected={on}
            className={`${p === ADJUSTMENT_PERIOD ? "adj" : "m"}${on ? " on" : ""}${edge}`}
            title={`${periodLabel(p)}（Shift + クリックかドラッグで、期間をまたいで選べます）`}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              if (e.shiftKey) {
                range(all ? p : from, p);
                return;
              }
              anchor.current = p;
              onChange(p, p);
            }}
            onMouseEnter={() => {
              if (anchor.current !== null) range(anchor.current, p);
            }}
            onKeyDown={(e) => {
              // キーボードでは Enter / Space で1つ（Shift つきで範囲）
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              if (e.shiftKey) range(all ? p : from, p);
              else onChange(p, p);
            }}
          >
            {p === ADJUSTMENT_PERIOD ? "決算整理" : p}
          </button>
        );
      })}
    </div>
  );
};
