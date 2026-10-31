/**
 * ホーム
 * 今年の数字をひと目で確認し、よく使う入力画面へすぐ移れるようにします。
 * 「次にやること」に、未登録の明細・消費税の確認の件数と、年末からは決算と申告（期限）・繰越を出します。
 */
import { useEffect, useMemo, useState } from "react";
import { BookOpen, ChevronRight, FileText, TriangleAlert } from "lucide-react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { buildMonthly, closingBalances, groupByEntry, openingDifference, summarizeIncome } from "../../lib/accounting";
import { longDate, shortDate, todayIso, yen } from "../../lib/format";
import { consumptionTaxDeadline, daysUntil, incomeTaxDeadline } from "../../lib/deadlines";
import { useTaxIssues } from "../reports/TaxPage";
import * as repo from "../../db/repo";
import type { Page } from "../../App";
import { fileLabel } from "../../lib/business";

/** 次にやること（件数があるもの・時期が来たものだけ） */
const useNextTasks = () => {
  const { db, year, taxYear, isClosed, dataVersion } = useAppContext();
  const { issues } = useTaxIssues();
  const [info, setInfo] = useState<{ pendingBank: number; nextOpening: boolean; holidays: Set<string> } | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([repo.countPendingBankLines(db, year), repo.hasOpening(db, year + 1), repo.getHolidayData(db)])
      .then(([pendingBank, nextOpening, h]) => alive && setInfo({ pendingBank, nextOpening, holidays: new Set(h.holidays.map((x) => x.date)) }))
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [db, year, dataVersion]);
  if (!info) return [];
  const today = todayIso();
  const tasks: { text: string; page: Page; tone: "todo" | "warn" }[] = [];
  if (info.pendingBank > 0) tasks.push({ text: `銀行・カードの明細が ${info.pendingBank} 件、仕訳になっていません`, page: "cashbook", tone: "todo" });
  const taxToFix = taxYear.status === "exempt" ? 0 : issues.filter((i) => i.level !== "info").length;
  if (taxToFix > 0) tasks.push({ text: `消費税の確認が ${taxToFix} 件あります`, page: "tax", tone: "warn" });
  // 12月からは決算と申告（締めるまで）
  if (!isClosed && today >= `${year}-12-01`) {
    const due = (label: string, date: string) => {
      const left = daysUntil(today, date);
      return `${label}は ${longDate(date)} まで${left < 0 ? "（過ぎています）" : left <= 60 ? `（あと${left}日）` : ""}`;
    };
    const income = incomeTaxDeadline(year, info.holidays);
    const tone = daysUntil(today, income) < 0 ? "warn" : "todo";
    tasks.push({ text: `${year}年の決算と申告：${due("所得税の申告", income)}`, page: "yearend", tone });
    if (taxYear.status !== "exempt") tasks.push({ text: `${year}年の${due("消費税の申告", consumptionTaxDeadline(year, info.holidays))}`, page: "tax", tone });
  }
  if (today >= `${year + 1}-01-01` && !info.nextOpening) tasks.push({ text: `${year + 1}年への繰越がまだです（決算整理の画面の最後）`, page: "yearend", tone: "todo" });
  return tasks;
};

export const DashboardPage = ({ go }: { go: (p: Page) => void }) => {
  const { year, accounts, accountMap, settings } = useAppContext();
  const { lines, opening } = useYearData();
  const tasks = useNextTasks();

  const end = useMemo(() => closingBalances(accounts, opening, lines), [accounts, opening, lines]);
  const pl = summarizeIncome(accounts, end);
  const monthly = useMemo(() => buildMonthly(accounts, lines, year), [accounts, lines, year]);
  const peak = Math.max(1, ...monthly.map((m) => Math.max(m.revenue, m.costs)));
  const money = accounts.filter((a) => ["101", "102", "103", "104"].includes(a.code) && (a.is_active || end.get(a.id)));
  const recent = useMemo(() => {
    const groups = [...groupByEntry(lines).values()];
    return groups.sort((a, b) => (a[0].date === b[0].date ? b[0].entry_id - a[0].entry_id : a[0].date < b[0].date ? 1 : -1)).slice(0, 8);
  }, [lines]);
  const openingOff = openingDifference(accounts, opening).difference !== 0;

  return (
    <div className="page">
      <div className="home-head">
        <div>
          <h1>{fileLabel(settings)}</h1>
          <p className="page-note">{year}年の帳簿　仕訳 {groupByEntry(lines).size} 件</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={() => go("cashbook")}><BookOpen size={16} /> 帳簿に入力する</button>
          <button className="btn ghost" onClick={() => go("voucher")}><FileText size={16} /> 振替伝票</button>
        </div>
      </div>

      {openingOff && (
        <button className="warn-box clickable" onClick={() => go("opening")}>
          <TriangleAlert size={16} /> 期首残高の貸借が一致していません。期首残高を確認してください。
        </button>
      )}

      {tasks.length > 0 && (
        <section className="sheet next-tasks" aria-label="次にやること">
          <h2 className="sheet-h">次にやること（{year}年）</h2>
          <ul>
            {tasks.map((t) => (
              <li key={t.text} className={t.tone}>
                <button className="link-btn" onClick={() => go(t.page)}>{t.text}<ChevronRight size={14} /></button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="figures" aria-label="今年の集計">
        <div className="figure">
          <span className="figure-label">売上（収入）</span>
          <span className="figure-value">{yen(pl.revenue)}<small>円</small></span>
        </div>
        <div className="figure">
          <span className="figure-label">経費・原価</span>
          <span className="figure-value">{yen(pl.cogs + pl.expenses + pl.special)}<small>円</small></span>
        </div>
        <div className="figure figure-main">
          <span className="figure-label">所得（控除前）</span>
          <span className={`figure-value${pl.income < 0 ? " negative" : ""}`}>{yen(pl.income)}<small>円</small></span>
        </div>
        {money.map((a) => (
          <div key={a.id} className="figure figure-small">
            <span className="figure-label">{a.name}残高</span>
            <span className={`figure-value${(end.get(a.id) ?? 0) < 0 ? " negative" : ""}`}>{yen(end.get(a.id) ?? 0)}<small>円</small></span>
          </div>
        ))}
      </section>

      <div className="home-grid">
        <section className="sheet">
          <h2 className="sheet-h">月別の推移</h2>
          <table className="ledger monthly-table">
            <thead>
              <tr><th>月</th><th className="num">売上</th><th className="num">経費・原価</th><th className="num">所得</th><th className="bar-col" aria-hidden /></tr>
            </thead>
            <tbody>
              {monthly.map((m) => (
                <tr key={m.month}>
                  <td>{m.month}月</td>
                  <td className="num">{yen(m.revenue, { blankZero: true })}</td>
                  <td className="num">{yen(m.costs, { blankZero: true })}</td>
                  <td className={`num${m.income < 0 ? " negative" : ""}`}>{yen(m.income, { blankZero: true })}</td>
                  <td className="bar-col" aria-hidden>
                    <span className="bar bar-rev" style={{ width: `${(m.revenue / peak) * 100}%` }} />
                    <span className="bar bar-cost" style={{ width: `${(Math.max(0, m.costs) / peak) * 100}%` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="legend"><span className="sw sw-rev" />売上　<span className="sw sw-cost" />経費・原価</p>
        </section>

        <section className="sheet">
          <h2 className="sheet-h">最近の仕訳</h2>
          {recent.length === 0 ? (
            <div className="empty">
              <p>まだ仕訳がありません。</p>
              <p className="muted">最初は「期首残高」で手元の現金と預金の残高を入れ、そのあと帳簿入力から始めるのがおすすめです。</p>
              <button className="btn ghost" onClick={() => go("opening")}>期首残高を入れる</button>
            </div>
          ) : (
            <ul className="recent">
              {recent.map((ls) => {
                const dr = ls.filter((l) => l.side === "debit");
                const cr = ls.filter((l) => l.side === "credit");
                const name = (xs: typeof ls) => (new Set(xs.map((x) => x.account_id)).size > 1 ? "諸口" : accountMap.get(xs[0]?.account_id)?.name);
                const amount = dr.reduce((s, l) => s + l.amount, 0);
                return (
                  <li key={ls[0].entry_id}>
                    <span className="recent-date">{shortDate(ls[0].date)}</span>
                    <span className="recent-accts">{name(dr)} / {name(cr)}</span>
                    <span className="recent-memo">{ls[0].memo || ls[0].description}</span>
                    <span className="num">{yen(amount)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};
