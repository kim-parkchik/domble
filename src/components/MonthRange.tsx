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
 * 期間の範囲選択（1月〜12月と、12月のあとの「決算整理」）。
 * 1月〜12月 = 決算整理前、1月〜決算整理 = 決算整理後（通期）、決算整理〜決算整理 = 決算整理仕訳だけ
 */
export const MonthRange = ({ from, to, onChange }: Props) => (
  <div className="month-range">
    <select value={from} onChange={(e) => onChange(Number(e.target.value), Math.max(Number(e.target.value), to))} aria-label="開始の期間">
      {PERIODS.map((p) => <option key={p} value={p}>{periodLabel(p)}</option>)}
    </select>
    <span>〜</span>
    <select value={to} onChange={(e) => onChange(Math.min(from, Number(e.target.value)), Number(e.target.value))} aria-label="終わりの期間">
      {PERIODS.map((p) => <option key={p} value={p}>{periodLabel(p)}</option>)}
    </select>
    <button className="link-btn" onClick={() => onChange(1, ADJUSTMENT_PERIOD)} title="1月〜決算整理（決算整理後）">通期</button>
    <button className="link-btn" onClick={() => onChange(1, 12)} title="1月〜12月（決算整理仕訳を含まない）">決算整理前</button>
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
  const periods = [...MONTHS, ADJUSTMENT_PERIOD];

  return (
    <div className="month-tabs" role="tablist" aria-label="期間（Shift + クリックかドラッグで複数の期間）">
      <button role="tab" aria-selected={all} className={`all${all ? " on" : ""}`} onClick={() => onChange(1, ADJUSTMENT_PERIOD)}>全期間</button>
      {periods.map((p) => {
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
