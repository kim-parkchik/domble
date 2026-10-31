/**
 * 残高試算表（貸借対照表 / 損益計算書）と、月次推移表・前年比較（計算は lib/trend.ts）
 * 印刷は貸借対照表と損益計算書を続けて（それぞれ新しいページから。月次推移表は A4 横）。
 * CSV は残高試算表・前年比較は両方を1つのファイルに、月次推移表は表示中の方（列が違うため）
 */
import { useEffect, useMemo, useState } from "react";
import { Download, Printer } from "lucide-react";
import { useAppContext, useYearData } from "../../context/AppContext";
import * as repo from "../../db/repo";
import { PageHeader } from "../../components/PageHeader";
import { PeriodTabs, periodLabel } from "../../components/MonthRange";
import { PrintPreview } from "../../components/PrintPreview";
import { exportCsvFile } from "../../components/csvExport";
import { useToast } from "../../components/Toast";
import { ADJUSTMENT_PERIOD, buildTrialBalance, periodNote, yearEnd, yearStart } from "../../lib/accounting";
import { todayIso, yen } from "../../lib/format";
import { multiCsvRows, multiSection, TRIAL_CSV_HEADER, trialSection, type TrialPrintLine } from "../../lib/printBooks";
import { changeRate, compareLines, trendHeads, trendLines, type BookData, type MultiLine } from "../../lib/trend";
import { bookLines, exclusiveAccountsOf } from "../../lib/taxExclusive";
import { ownerText, periodsText, type PrintDoc } from "../../lib/printLayout";
import { fileLabel } from "../../lib/business";
import { trialCsvRows, trialLines, VIEW_LABEL, type StatementView } from "../../lib/bookExport";

type View = StatementView;
/** 表の種類：残高試算表・月次推移表・前年比較 */
type Mode = "tb" | "trend" | "compare";
const MODE_LABEL: Record<Mode, string> = { tb: "残高試算表", trend: "月次推移表", compare: "前年比較" };

export const TrialBalancePage = () => {
  const { db, year, accounts, subAccounts, settings, dataVersion, taxYears } = useAppContext();
  const { lines, opening, subOpening } = useYearData();
  const [mode, setMode] = useState<Mode>("tb");
  const toast = useToast();
  const [printing, setPrinting] = useState(false);
  const [showSubs, setShowSubs] = useState(true);
  const [view, setView] = useState<View>("bs");
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(ADJUSTMENT_PERIOD);
  const [hideZero, setHideZero] = useState(true);

  const rows = useMemo(() => buildTrialBalance(accounts, opening, lines, from, to), [accounts, opening, lines, from, to]);

  // ── 月次推移表・前年比較 ──
  const book: BookData = useMemo(() => ({ opening, subOpening, lines }), [opening, subOpening, lines]);
  // 前年の帳簿（前年比較を開いたときだけ読む）
  const [prev, setPrev] = useState<BookData | null>(null);
  useEffect(() => {
    if (mode !== "compare") return;
    let alive = true;
    setPrev(null);
    Promise.all([repo.getLines(db, yearStart(year - 1), yearEnd(year - 1)), repo.getOpening(db, year - 1)])
      .then(([l, o]) => alive && setPrev({ lines: bookLines(l, taxYears, exclusiveAccountsOf(accounts)), opening: o.byAccount, subOpening: o.bySub }))
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [mode, db, year, dataVersion, taxYears, accounts]);
  const prevEmpty = !!prev && prev.lines.length === 0 && Object.values(prev.subOpening).every((v) => !v);
  const opts = { showSubs, hideZero };
  const multiOf = (v: View): MultiLine[] =>
    mode === "trend" ? trendLines(v, accounts, subAccounts, book, from, to, opts)
      : mode === "compare" && prev ? compareLines(v, accounts, subAccounts, book, prev, from, to, opts) : [];
  const headsOf = (v: View) => (mode === "trend" ? trendHeads(v, from, to) : [`${year}年`, `${year - 1}年`, "差額"]);
  const multi = useMemo(() => (mode === "tb" ? [] : multiOf(view)), [mode, view, accounts, subAccounts, book, prev, from, to, showSubs, hideZero]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 画面と印刷の行（区分の見出し・科目・補助科目・小計、最後に所得金額。lib/bookExport.ts） */
  const linesOf = (v: View): TrialPrintLine[] => trialLines(v, { accounts, subs: subAccounts, opening, subOpening, lines }, from, to, { showSubs, hideZero });
  const shown = linesOf(view);
  // 所得金額（最後の行）
  const income = shown[shown.length - 1];
  const carriedHead = from === 1 ? "前期繰越" : from === ADJUSTMENT_PERIOD ? "12月末残高" : "前月繰越";
  const balanceHead = to === ADJUSTMENT_PERIOD ? (from === 1 ? "期末残高" : "決算整理後残高") : `${to}月末残高`;

  const printDoc = useMemo((): PrintDoc | null => {
    if (!printing) return null;
    const head = { owner: ownerText(settings.business_name, settings.owner_name), printedOn: todayIso() };
    if (mode === "trend") {
      return {
        ...head, title: "月次推移表", period: periodsText(year, from, to), landscape: true,
        sections: (["bs", "pl"] as View[]).map((v) => multiSection(VIEW_LABEL[v], multiOf(v), headsOf(v))),
      };
    }
    if (mode === "compare") {
      if (!prev) return null;
      return {
        ...head, title: "前年比較表", period: `${periodsText(year, from, to)}（${year - 1}年の同じ期間と比べる）`,
        sections: (["bs", "pl"] as View[]).map((v) => multiSection(VIEW_LABEL[v], multiOf(v), headsOf(v), true)),
      };
    }
    return {
      ...head, title: "残高試算表", period: periodsText(year, from, to),
      sections: (["bs", "pl"] as View[]).map((v) => trialSection(VIEW_LABEL[v], linesOf(v), carriedHead, balanceHead)),
    };
  }, [printing, mode, rows, prev, hideZero, showSubs, settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportCsv = () => {
    const name = `${fileLabel(settings)}_${year}_${periodLabel(from)}-${periodLabel(to)}`;
    if (mode === "trend") {
      exportCsvFile(`月次推移表_${VIEW_LABEL[view]}_${name}.csv`, ["区分", "勘定科目", "補助科目", ...headsOf(view)], multiCsvRows(VIEW_LABEL[view], multi), toast);
      return;
    }
    if (mode === "compare") {
      const body = (["bs", "pl"] as View[]).flatMap((v) => multiCsvRows(VIEW_LABEL[v], multiOf(v), true));
      exportCsvFile(`前年比較_${name}.csv`, ["区分", "勘定科目", "補助科目", ...headsOf("pl"), "増減率"], body, toast);
      return;
    }
    const body = (["bs", "pl"] as View[]).flatMap((v) => trialCsvRows(v, linesOf(v)));
    exportCsvFile(`残高試算表_${name}.csv`, TRIAL_CSV_HEADER, body, toast);
  };

  return (
    <div className="page">
      <PageHeader title="残高試算表">
        <PeriodTabs from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
        {periodNote(from, to) && <span className="badge badge-adjust period-note">{periodNote(from, to)}</span>}
        <button className="btn ghost" onClick={exportCsv} disabled={mode === "compare" && !prev}
          title={mode === "trend" ? `表示中の${VIEW_LABEL[view]}の月次推移表を、表示中の期間・条件で書き出します` : `貸借対照表と損益計算書の${MODE_LABEL[mode]}を、表示中の期間・条件で書き出します`}>
          <Download size={16} /> CSV 書き出し
        </button>
        <button className="btn ghost" onClick={() => setPrinting(true)} disabled={mode === "compare" && !prev}
          title={`貸借対照表と損益計算書の${MODE_LABEL[mode]}を、表示中の期間・条件で印刷します${mode === "trend" ? "（A4 横）" : ""}`}>
          <Printer size={16} /> 印刷
        </button>
      </PageHeader>

      <div className="filters">
        <div className="seg" role="tablist" aria-label="表の種類">
          {(["tb", "trend", "compare"] as Mode[]).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{MODE_LABEL[m]}</button>
          ))}
        </div>
        <div className="seg" role="tablist" aria-label="貸借対照表・損益計算書">
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

      {mode !== "tb" && (
        <p className="field-note">
          {mode === "trend"
            ? view === "pl" ? "損益の科目は、期間ごとの発生額（科目の残高の側を＋）と合計です。" : "貸借の科目は、期首（前月末）と期間ごとの末の残高です。"
            : `表示中の期間を、${year - 1}年の同じ期間と比べます（${view === "pl" ? "期間の発生額" : "期間の末の残高"}）。増減率は前年を 100% とした増え方です。`}
        </p>
      )}
      {mode === "compare" && prevEmpty && <p className="notice">{year - 1}年の帳簿（仕訳・期首残高）がないので、前年の欄は 0 です。</p>}

      {mode !== "tb" ? (
        <MultiTable lines={multi} heads={headsOf(view)} rate={mode === "compare"} loading={mode === "compare" && !prev} />
      ) : (
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
                <td className="num">{yen(income.carried)}</td>
                <td colSpan={2} className="num muted">期間中 {yen(income.balance - income.carried)}</td>
                <td className={`num${income.balance < 0 ? " negative" : ""}`}>{yen(income.balance)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
      )}

      {printing && <PrintPreview doc={printDoc} onClose={() => setPrinting(false)} />}
    </div>
  );
};

/** 月次推移表・前年比較の表（rate = 増減率の列を足す） */
const MultiTable = ({ lines, heads, rate, loading }: { lines: MultiLine[]; heads: string[]; rate: boolean; loading: boolean }) => {
  const cols = heads.length + (rate ? 1 : 0) + 1;
  const total = lines.find((l) => l.kind === "total");
  const amount = (v: number, i: number, kind: MultiLine["kind"]) => (
    <td key={i} className={`num${v < 0 && kind !== "subtotal" ? " negative" : ""}`}>{yen(v, { blankZero: kind === "account" || kind === "sub" })}</td>
  );
  return (
    <section className="sheet sheet-fill">
      <div className="table-wrap scroll-y">
        <table className={`ledger tb-table multi-table${rate ? "" : " trend-table"}`}>
          <thead>
            <tr>
              <th>勘定科目</th>
              {heads.map((h) => <th key={h} className="num">{h}</th>)}
              {rate && <th className="num">増減率</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr className="empty-row"><td colSpan={cols}>前年の帳簿を読んでいます…</td></tr>}
            {lines.filter((l) => l.kind !== "total").map((l, i) => {
              if (l.kind === "category") return <tr key={i} className="cat-row"><td colSpan={cols}>{l.label}</td></tr>;
              return (
                <tr key={i} className={l.kind === "subtotal" ? "subtotal" : l.kind === "sub" ? "sub-row" : undefined}>
                  <td className={l.kind === "account" ? "indent" : l.kind === "sub" ? "indent2" : undefined}>{l.label}</td>
                  {l.values.map((v, j) => amount(v, j, l.kind))}
                  {rate && <td className="num muted">{changeRate(l.values[0], l.values[1])}</td>}
                </tr>
              );
            })}
          </tbody>
          {total && (
            <tfoot>
              <tr className="grand">
                <td>{total.label}</td>
                {total.values.map((v, j) => <td key={j} className={`num${v < 0 ? " negative" : ""}`}>{yen(v)}</td>)}
                {rate && <td className="num muted">{changeRate(total.values[0], total.values[1])}</td>}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
};
