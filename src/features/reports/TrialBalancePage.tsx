/**
 * 残高試算表（貸借対照表 / 損益計算書）
 * 印刷は貸借対照表と損益計算書を続けて（それぞれ新しいページから）。CSV も両方を1つのファイルに
 */
import { useMemo, useState } from "react";
import { Download, Printer } from "lucide-react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { MonthRange, periodLabel } from "../../components/MonthRange";
import { PrintPreview } from "../../components/PrintPreview";
import { exportCsvFile } from "../../components/csvExport";
import { useToast } from "../../components/Toast";
import {
  ADJUSTMENT_PERIOD, buildTrialBalance, periodNote, subTrialRow, summarizeIncome, type TrialBalanceRow,
} from "../../lib/accounting";
import { todayIso, yen } from "../../lib/format";
import { TRIAL_CSV_HEADER, trialSection, type TrialPrintLine } from "../../lib/printBooks";
import { ownerText, periodsText, type PrintDoc } from "../../lib/printLayout";
import { BS_CATEGORIES, CATEGORY_LABEL, PL_CATEGORIES } from "../../constants/accounts";
import type { AccountCategory } from "../../lib/types";

type View = "bs" | "pl";
const VIEW_LABEL: Record<View, string> = { bs: "貸借対照表", pl: "損益計算書" };

export const TrialBalancePage = () => {
  const { year, accounts, subAccounts, settings } = useAppContext();
  const { lines, opening, subOpening } = useYearData();
  const toast = useToast();
  const [printing, setPrinting] = useState(false);
  const [showSubs, setShowSubs] = useState(true);
  const [view, setView] = useState<View>("bs");
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(ADJUSTMENT_PERIOD);
  const [hideZero, setHideZero] = useState(true);

  const rows = useMemo(() => buildTrialBalance(accounts, opening, lines, from, to), [accounts, opening, lines, from, to]);

  const toBalances = (pick: (r: TrialBalanceRow) => number) => new Map(rows.map((r) => [r.account.id, pick(r)]));
  const incomeCarried = summarizeIncome(accounts, toBalances((r) => r.carried)).income;
  const incomeEnd = summarizeIncome(accounts, toBalances((r) => r.balance)).income;
  const incomeDuring = incomeEnd - incomeCarried;

  const isEmpty = (r: TrialBalanceRow) => r.carried === 0 && r.debit === 0 && r.credit === 0 && r.balance === 0;

  const subtotal = (cat: AccountCategory) =>
    rows
      .filter((r) => r.account.category === cat)
      .reduce(
        (t, r) => {
          // 期末商品棚卸高は原価のマイナスとして集計
          const sign = cat === "cogs" && r.account.normal_side === "credit" ? -1 : 1;
          return {
            carried: t.carried + sign * r.carried,
            debit: t.debit + r.debit,
            credit: t.credit + r.credit,
            balance: t.balance + sign * r.balance,
          };
        },
        { carried: 0, debit: 0, credit: 0, balance: 0 },
      );

  /** 画面と印刷の行（区分の見出し・科目・補助科目・小計、最後に所得金額） */
  const linesOf = (v: View): TrialPrintLine[] => {
    const out: TrialPrintLine[] = [];
    const amounts = (r: TrialBalanceRow) => ({ carried: r.carried, debit: r.debit, credit: r.credit, balance: r.balance });
    for (const cat of v === "bs" ? BS_CATEGORIES : PL_CATEGORIES) {
      out.push({ kind: "category", label: CATEGORY_LABEL[cat], carried: 0, debit: 0, credit: 0, balance: 0 });
      for (const r of rows.filter((x) => x.account.category === cat && !(hideZero && isEmpty(x)))) {
        out.push({ kind: "account", label: r.account.name, ...amounts(r) });
        const subs = showSubs ? subAccounts.filter((x) => x.account_id === r.account.id) : [];
        if (subs.length === 0) continue;
        const sub = (id: number | null) => subTrialRow(r.account, id, subOpening, lines, from, to);
        for (const [label, row] of [...subs.map((x) => [x.name, sub(x.id)] as const), ["補助なし", sub(null)] as const])
          if (!(hideZero && isEmpty(row))) out.push({ kind: "sub", label, ...amounts(row) });
      }
      out.push({ kind: "subtotal", label: `${CATEGORY_LABEL[cat]}合計`, ...subtotal(cat) });
    }
    out.push({
      kind: "total", label: v === "bs" ? "所得金額（当期の利益）" : "青色申告特別控除前の所得金額",
      carried: incomeCarried, debit: 0, credit: 0, balance: incomeEnd, middle: `期間中 ${yen(incomeDuring)}`,
    });
    return out;
  };
  const shown = linesOf(view);
  const carriedHead = from === 1 ? "前期繰越" : from === ADJUSTMENT_PERIOD ? "12月末残高" : "前月繰越";
  const balanceHead = to === ADJUSTMENT_PERIOD ? (from === 1 ? "期末残高" : "決算整理後残高") : `${to}月末残高`;

  const printDoc = useMemo((): PrintDoc | null => {
    if (!printing) return null;
    return {
      title: "残高試算表", owner: ownerText(settings.business_name, settings.owner_name),
      period: periodsText(year, from, to), printedOn: todayIso(),
      sections: (["bs", "pl"] as View[]).map((v) => trialSection(VIEW_LABEL[v], linesOf(v), carriedHead, balanceHead)),
    };
  }, [printing, rows, hideZero, showSubs, settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportCsv = () => {
    // 区分は「貸借対照表・資産」など。補助科目の行は科目の名前も入れる
    const body = (["bs", "pl"] as View[]).flatMap((v) => {
      let cat = "";
      let parent = "";
      return linesOf(v).flatMap((l) => {
        if (l.kind === "category") cat = l.label;
        if (l.kind === "account") parent = l.label;
        if (l.kind === "category") return [];
        if (l.kind === "total") return [[VIEW_LABEL[v], l.label, "", l.carried, "", "", l.balance]];
        return [[`${VIEW_LABEL[v]}・${cat}`, l.kind === "sub" ? parent : l.label, l.kind === "sub" ? l.label : "", l.carried, l.debit, l.credit, l.balance]];
      });
    });
    exportCsvFile(`残高試算表_${settings.business_name || "帳簿"}_${year}_${periodLabel(from)}-${periodLabel(to)}.csv`, TRIAL_CSV_HEADER, body, toast);
  };

  return (
    <div className="page">
      <PageHeader title="残高試算表">
        <MonthRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
        {periodNote(from, to) && <span className="badge badge-adjust period-note">{periodNote(from, to)}</span>}
        <button className="btn ghost" onClick={exportCsv} title="貸借対照表と損益計算書を、表示中の期間・条件で書き出します"><Download size={16} /> CSV 書き出し</button>
        <button className="btn ghost" onClick={() => setPrinting(true)} title="貸借対照表と損益計算書を、表示中の期間・条件で印刷します"><Printer size={16} /> 印刷</button>
      </PageHeader>

      <div className="filters">
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={view === "bs"} className={view === "bs" ? "on" : ""} onClick={() => setView("bs")}>貸借対照表</button>
          <button role="tab" aria-selected={view === "pl"} className={view === "pl" ? "on" : ""} onClick={() => setView("pl")}>損益計算書</button>
        </div>
        <label className="check">
          <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} /> 金額のない科目を隠す
        </label>
        <label className="check">
          <input type="checkbox" checked={showSubs} onChange={(e) => setShowSubs(e.target.checked)} /> 補助科目の内訳も表示
        </label>
      </div>

      <section className="sheet sheet-fill">
        <div className="table-wrap scroll-y">
          <table className="ledger tb-table">
            <colgroup>
              <col />
              <col style={{ width: "17%" }} />
              <col style={{ width: "17%" }} />
              <col style={{ width: "17%" }} />
              <col style={{ width: "17%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>勘定科目</th>
                <th className="num">{carriedHead}</th>
                <th className="num dr">借方</th>
                <th className="num cr">貸方</th>
                <th className="num">{balanceHead}</th>
              </tr>
            </thead>
            <tbody>
              {shown.filter((l) => l.kind !== "total").map((l, i) => {
                if (l.kind === "category") return <tr key={i} className="cat-row"><td colSpan={5}>{l.label}</td></tr>;
                const cls = l.kind === "subtotal" ? "subtotal" : l.kind === "sub" ? "sub-row" : undefined;
                const blank = l.kind !== "subtotal";
                return (
                  <tr key={i} className={cls}>
                    <td className={l.kind === "account" ? "indent" : l.kind === "sub" ? "indent2" : undefined}>{l.label}</td>
                    <td className="num">{yen(l.carried)}</td>
                    <td className="num">{yen(l.debit, { blankZero: blank })}</td>
                    <td className="num">{yen(l.credit, { blankZero: blank })}</td>
                    <td className={`num${l.balance < 0 && l.kind !== "subtotal" ? " negative" : ""}`}>{yen(l.balance)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="grand">
                <td>{view === "bs" ? "所得金額（当期の利益）" : "青色申告特別控除前の所得金額"}</td>
                <td className="num">{yen(incomeCarried)}</td>
                <td colSpan={2} className="num muted">期間中 {yen(incomeDuring)}</td>
                <td className={`num${incomeEnd < 0 ? " negative" : ""}`}>{yen(incomeEnd)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {printing && <PrintPreview doc={printDoc} onClose={() => setPrinting(false)} />}
    </div>
  );
};
