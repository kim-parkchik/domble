/**
 * 画面上部のお知らせ
 *  - 表示中の年度が締め済み（年の締め）・何月まで締めたか（月の締め）
 *  - 期首残高が前年の繰越額とずれている（前の年度を直したあと、繰越をやり直していない）
 *  - 前の年から引き継いだ消費税の課税区分が、その年には使えない（2割特例のまま 2027年に入った、など）
 */
import { Lock, TriangleAlert } from "lucide-react";
import { useAppContext, useCarryForwardCheck } from "../context/AppContext";
import { statusProblem } from "../lib/tax";
import { TAX_STATUS_OPTIONS } from "../constants/tax";

interface Props {
  goSettings: () => void;
  switchYear: (y: number) => void;
}

export const YearNotice = ({ goSettings, switchYear }: Props) => {
  const { year, isClosed, closedMonth, labelOf, taxYear } = useAppContext();
  const taxProblem = statusProblem(taxYear.status, year);
  const checks = useCarryForwardCheck();

  const names = (keys: string[]) => {
    const list = keys.map((k) => {
      const [acc, sub] = k.split(":").map(Number);
      return labelOf(acc, sub || null);
    });
    return list.length > 3 ? `${list.slice(0, 3).join("、")} ほか${list.length - 3}件` : list.join("、");
  };

  if (!isClosed && closedMonth === 0 && checks.length === 0 && !taxProblem) return null;
  return (
    <div className="year-notice">
      {isClosed ? (
        <div className="year-notice-row closed">
          <Lock size={15} />
          <span>{year}年は締め済みです。仕訳・期首残高・家事按分は変更できません。</span>
          <button className="btn ghost sm" onClick={goSettings}>締めを戻す（事業者設定）</button>
        </div>
      ) : closedMonth > 0 && (
        <div className="year-notice-row month-closed">
          <Lock size={14} />
          <span>{year}年は{closedMonth}月まで締め済みです。{closedMonth === 1 ? "1月" : `1〜${closedMonth}月`}の仕訳は変更できません。</span>
        </div>
      )}
      {taxProblem && (
        <div className="year-notice-row warn">
          <TriangleAlert size={15} />
          <span>
            {year}年の消費税の課税区分は、前の年の「{TAX_STATUS_OPTIONS.find((o) => o.value === taxYear.status)?.label}」を引き継いでいますが、{taxProblem}。選び直してください。
          </span>
          <button className="btn ghost sm" onClick={goSettings}>消費税の設定へ（事業者設定）</button>
        </div>
      )}
      {checks.map((c) => (
        <div key={c.from} className="year-notice-row warn">
          <TriangleAlert size={15} />
          <span>
            {c.to}年の期首残高が、{c.from}年の期末残高と一致しません（{names(c.mismatches.map((m) => m.key))}）。
            {c.from}年の帳簿を直した場合は、繰越をやり直してください。
          </span>
          {c.from === year
            ? <button className="btn ghost sm" onClick={goSettings}>繰越へ（事業者設定）</button>
            : <button className="btn ghost sm" onClick={() => switchYear(c.from)}>{c.from}年に切り替える</button>}
        </div>
      ))}
    </div>
  );
};
