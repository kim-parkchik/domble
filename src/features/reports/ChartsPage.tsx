/**
 * グラフ（集計のメニュー。数字は lib/charts.ts、部品は ChartParts.tsx）
 *  - 月ごとの推移：売上・経費（棒）と所得（線）。月ごと／累計、前年の売上を重ねる。決算整理の仕訳は「決算整理」に分ける
 *  - 経費の内訳・売上の内訳：大きい順の横棒と割合、前年との比べ
 *  - 現金・預金：現金・預金の合計の月末残高（線）と、月ごとの入金・出金（棒）。科目ごとの残高は表で
 * どのグラフも、下に同じ数字の表を出す。印刷は A4 横（表示中のタブ、または まとめて）
 * 税抜経理の年は税抜きの帳簿の明細で（残高試算表・決算書と同じ）
 */
import { useEffect, useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { closingBalances, yearEnd, yearStart, type FlatLine } from "../../lib/accounting";
import { bookLines, exclusiveAccountsOf } from "../../lib/taxExclusive";
import { cashFlow, cumulative, expenseBreakdown, monthPoints, periodLabel, revenueBreakdown, type Breakdown } from "../../lib/charts";
import { ownerText } from "../../lib/printLayout";
import { yen } from "../../lib/format";
import { ColumnLineChart, HBarList, type ChartSeries } from "./ChartParts";
import * as repo from "../../db/repo";

type Tab = "trend" | "expense" | "revenue" | "cash";
const TAB_LABEL: Record<Tab, string> = { trend: "月ごとの推移", expense: "経費の内訳", revenue: "売上の内訳", cash: "現金・預金" };
const TABS = Object.keys(TAB_LABEL) as Tab[];

const SERIES = { s1: "var(--series-1)", s2: "var(--series-2)", s3: "var(--series-3)", muted: "var(--series-muted)" };

const signedYen = (n: number) => (n > 0 ? `+${yen(n)}` : n < 0 ? `△${yen(-n)}` : "0");
const diffCell = (cur: number, prev: number | null) => (prev === null ? "" : signedYen(cur - prev));

/** 前年の帳簿（帳簿の明細。無ければ空） */
const usePrevLines = () => {
  const { db, year, accounts, taxYears, dataVersion } = useAppContext();
  const [prev, setPrev] = useState<FlatLine[] | null>(null);
  useEffect(() => {
    let alive = true;
    repo.getLines(db, yearStart(year - 1), yearEnd(year - 1))
      .then((l) => alive && setPrev(bookLines(l, taxYears, exclusiveAccountsOf(accounts))))
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [db, year, accounts, taxYears, dataVersion]);
  return prev;
};

const TrendView = ({ lines, prevLines }: { lines: FlatLine[]; prevLines: FlatLine[] | null }) => {
  const { accounts } = useAppContext();
  const [mode, setMode] = useState<"month" | "total">("month");
  const [showPrev, setShowPrev] = useState(true);
  const hasPrev = !!prevLines?.length;
  const points = useMemo(() => monthPoints(accounts, lines), [accounts, lines]);
  const prevPoints = useMemo(() => (hasPrev ? monthPoints(accounts, prevLines!) : null), [accounts, prevLines, hasPrev]);
  const shown = mode === "total" ? cumulative(points) : points;
  // 前年は今年と同じ区切り（今年に決算整理が無く前年にあれば、累計では12月に含める）
  const prevShown = prevPoints && (() => {
    const base = mode === "total" ? cumulative(prevPoints) : prevPoints;
    return shown.map((p) => base.find((x) => x.period === p.period)?.revenue ?? (mode === "total" ? base[base.length - 1].revenue : 0));
  })();
  const categories = shown.map((p) => periodLabel(p.period));
  const bars: ChartSeries[] = [
    { key: "rev", label: "売上", color: SERIES.s1, values: shown.map((p) => p.revenue) },
    { key: "cost", label: "経費・原価", color: SERIES.s2, values: shown.map((p) => p.costs) },
  ];
  const lineSeries: ChartSeries[] = [
    { key: "inc", label: "所得", color: SERIES.s3, values: shown.map((p) => p.income) },
    ...(prevShown && showPrev ? [{ key: "prev", label: "前年の売上", color: SERIES.muted, values: prevShown }] : []),
  ];
  const sums = cumulative(points);
  const total = sums[sums.length - 1];
  return (
    <>
      <div className="chart-controls print-skip">
        <div className="seg" role="tablist" aria-label="表し方">
          <button role="tab" aria-selected={mode === "month"} className={mode === "month" ? "on" : ""} onClick={() => setMode("month")}>月ごと</button>
          <button role="tab" aria-selected={mode === "total"} className={mode === "total" ? "on" : ""} onClick={() => setMode("total")}>累計</button>
        </div>
        <label className="check">
          <input type="checkbox" checked={showPrev && hasPrev} disabled={!hasPrev} onChange={(e) => setShowPrev(e.target.checked)} />
          前年の売上を重ねる{!hasPrev && "（前年の帳簿がありません）"}
        </label>
      </div>
      <ColumnLineChart label={`${TAB_LABEL.trend}（${mode === "total" ? "累計" : "月ごと"}）`} categories={categories} bars={bars} lines={lineSeries} />
      <p className="field-note">
        経費・原価は、売上原価・経費・繰入額等から繰戻額等を引いた額です。決算整理の仕訳（減価償却・棚卸など）は「決算整理」に分けています。
        年の合計：売上 {yen(total.revenue)}円・経費・原価 {yen(total.costs)}円・所得 {yen(total.income)}円（青色申告特別控除の前）。
      </p>
      <table className="ledger chart-table">
        <thead>
          <tr>
            <th>{mode === "total" ? "月まで" : "月"}</th><th className="num">売上</th><th className="num">経費・原価</th><th className="num">所得</th>
            {prevShown && <th className="num">前年の売上</th>}
          </tr>
        </thead>
        <tbody>
          {shown.map((p, i) => (
            <tr key={p.period}>
              <td>{periodLabel(p.period)}</td>
              <td className="num">{yen(p.revenue)}</td>
              <td className="num">{yen(p.costs)}</td>
              <td className={`num${p.income < 0 ? " negative" : ""}`}>{yen(p.income)}</td>
              {prevShown && <td className="num">{yen(prevShown[i])}</td>}
            </tr>
          ))}
        </tbody>
        {mode === "month" && (
          <tfoot>
            <tr>
              <td>合計</td><td className="num">{yen(total.revenue)}</td><td className="num">{yen(total.costs)}</td>
              <td className={`num${total.income < 0 ? " negative" : ""}`}>{yen(total.income)}</td>
              {prevShown && <td className="num">{yen(prevShown.reduce((t, n) => t + n, 0))}</td>}
            </tr>
          </tfoot>
        )}
      </table>
    </>
  );
};

/** 内訳（横棒と表）。color は棒の色（そのほかは目立たせない） */
const BreakdownView = ({ b, color, title, nameHead, empty, note }: { b: Breakdown; color: string; title: string; nameHead: string; empty: string; note: string }) => {
  if (b.items.length === 0) return <p className="empty-note">{empty}</p>;
  const hasPrev = b.prevTotal !== null;
  return (
    <>
      <HBarList
        label={title}
        items={b.items.map((i) => ({
          key: i.key, label: i.label, amount: i.amount, share: i.share, color: i.key === "_others" ? SERIES.muted : color,
          note: i.others ? <small className="muted">（{i.others}件）</small> : undefined,
        }))}
      />
      <p className="field-note">{note}</p>
      <table className="ledger chart-table">
        <thead>
          <tr>
            <th>{nameHead}</th><th className="num">金額</th><th className="num">割合</th>
            {hasPrev && <><th className="num">前年</th><th className="num">増減</th></>}
          </tr>
        </thead>
        <tbody>
          {b.items.map((i) => (
            <tr key={i.key}>
              <td>{i.label}{i.others ? `（${i.others}件）` : ""}</td>
              <td className={`num${i.amount < 0 ? " negative" : ""}`}>{yen(i.amount)}</td>
              <td className="num">{i.share === null ? "" : `${i.share.toFixed(1)}%`}</td>
              {hasPrev && <><td className="num">{yen(i.prev ?? 0)}</td><td className="num">{diffCell(i.amount, i.prev)}</td></>}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>合計</td><td className="num">{yen(b.total)}</td><td />
            {hasPrev && <><td className="num">{yen(b.prevTotal!)}</td><td className="num">{diffCell(b.total, b.prevTotal)}</td></>}
          </tr>
        </tfoot>
      </table>
    </>
  );
};

const CashView = ({ lines }: { lines: FlatLine[] }) => {
  const { accounts } = useAppContext();
  const { opening } = useYearData();
  const c = useMemo(() => cashFlow(accounts, opening, lines), [accounts, opening, lines]);
  if (c.accounts.length === 0) return <p className="empty-note">現金・預金の残高も動きもありません。</p>;
  const months = c.months.map((m) => `${m.month}月`);
  return (
    <>
      <h3 className="sheet-sub">現金・預金の合計（月末の残高）</h3>
      <ColumnLineChart
        label="現金・預金の合計の月末残高" categories={["期首", ...months]} height={200}
        lines={[{ key: "total", label: "現金・預金の合計", color: SERIES.s1, values: [c.openingTotal, ...c.months.map((m) => m.total)] }]}
      />
      <h3 className="sheet-sub">月ごとの入金・出金</h3>
      <ColumnLineChart
        label="月ごとの入金・出金" categories={months} height={200}
        bars={[
          { key: "in", label: "入金", color: SERIES.s1, values: c.months.map((m) => m.inflow) },
          { key: "out", label: "出金", color: SERIES.s2, values: c.months.map((m) => m.outflow) },
        ]}
      />
      <p className="field-note">
        現金・当座預金・普通預金・定期預金の科目です（補助科目はまとめています）。1つの仕訳の中の現金・預金どうしの動き（預け入れ・引き出し）は、入金にも出金にも数えません。
      </p>
      <table className="ledger chart-table">
        <thead>
          <tr>
            <th>月</th><th className="num">入金</th><th className="num">出金</th>
            {c.accounts.map((a) => <th key={a.id} className="num">{a.name}</th>)}
            <th className="num">合計</th>
          </tr>
        </thead>
        <tbody>
          <tr className="muted">
            <td>期首</td><td /><td />
            {c.opening.map((v, i) => <td key={i} className="num">{yen(v)}</td>)}
            <td className="num">{yen(c.openingTotal)}</td>
          </tr>
          {c.months.map((m) => (
            <tr key={m.month}>
              <td>{m.month}月末</td>
              <td className="num">{yen(m.inflow)}</td>
              <td className="num">{yen(m.outflow)}</td>
              {m.balances.map((v, i) => <td key={i} className={`num${v < 0 ? " negative" : ""}`}>{yen(v)}</td>)}
              <td className={`num${m.total < 0 ? " negative" : ""}`}>{yen(m.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
};

export const ChartsPage = () => {
  const { year, accounts, subAccounts, counterparties, settings } = useAppContext();
  const { lines, opening } = useYearData();
  const prevLines = usePrevLines();
  const [tab, setTab] = useState<Tab>("trend");
  const end = useMemo(() => closingBalances(accounts, opening, lines), [accounts, opening, lines]);
  const prevEnd = useMemo(() => (prevLines?.length ? closingBalances(accounts, {}, prevLines) : null), [accounts, prevLines]);
  const expense = useMemo(() => expenseBreakdown(accounts, end, prevEnd), [accounts, end, prevEnd]);
  const revenue = useMemo(
    () => revenueBreakdown(accounts, subAccounts, counterparties, lines, prevLines?.length ? prevLines : null),
    [accounts, subAccounts, counterparties, lines, prevLines],
  );

  /** すべてのタブをまとめて印刷（画面は表示中のタブのまま） */
  const printAll = () => {
    document.body.classList.add("ch-print-all");
    const done = () => {
      document.body.classList.remove("ch-print-all");
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
  };

  return (
    <div className="page charts-page">
      <style>{"@media print { @page { size: A4 landscape; margin: 12mm; } }"}</style>
      <PageHeader title="グラフ" note={`${year}年の売上・経費・所得の推移と内訳、現金・預金の動きです。数字は残高試算表と同じ帳簿から出します。`}>
        <button className="btn ghost" onClick={() => window.print()} title="表示中のグラフを A4 横で印刷します"><Printer size={16} /> 印刷</button>
        <button className="btn ghost" onClick={printAll} title="4つのグラフをまとめて A4 横で印刷します"><Printer size={16} /> まとめて印刷</button>
      </PageHeader>
      <div className="seg chart-tabs print-skip" role="tablist" aria-label="グラフ">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{TAB_LABEL[t]}</button>
        ))}
      </div>
      {TABS.map((t) => (
        <section key={t} className={`sheet ch-page${tab === t ? "" : " ch-off"}`} aria-label={TAB_LABEL[t]}>
          <header className="ch-head">
            <h2 className="sheet-h">{TAB_LABEL[t]}（{year}年）</h2>
            <span className="print-only muted">{ownerText(settings.business_name, settings.owner_name)}</span>
          </header>
          {t === "trend" && <TrendView lines={lines} prevLines={prevLines} />}
          {t === "expense" && (
            <BreakdownView
              b={expense} color={SERIES.s2} title="経費の内訳" nameHead="科目" empty={`${year}年の経費はまだありません。`}
              note="売上原価は、期首商品棚卸高＋仕入高−期末商品棚卸高をまとめた額です。繰戻額等（貸倒引当金戻入など）は経費から引くマイナスの行です。上位10件のほかは「そのほか」にまとめています（表は同じ）。"
            />
          )}
          {t === "revenue" && (
            <BreakdownView
              b={revenue} color={SERIES.s1} title="売上の内訳" nameHead={revenue.by === "counterparty" ? "取引先" : "科目"} empty={`${year}年の売上はまだありません。`}
              note={revenue.by === "counterparty"
                ? "売上の区分の科目（売上高・雑収入など）を、仕訳の取引先ごとに集めています。取引先の無い仕訳は「取引先なし」です。返品・値引きは差し引いています。"
                : "仕訳に取引先が無いため、売上の区分の科目（補助科目）ごとに集めています。仕訳に取引先を入れると、取引先ごとに見られます。"}
            />
          )}
          {t === "cash" && <CashView lines={lines} />}
        </section>
      ))}
    </div>
  );
};
