/**
 * 消費税：集計表と確認の一覧（計算は lib/taxSummary.ts）
 *  - 集計表：区分（売上・売上の返還・仕入…）× 税区分 × インボイス区分（経過措置は控除できる割合ごと）。行を開くと科目ごとの内訳。
 *    月のボタンで期間を絞れる。「月次推移」で税区分 × 月（税込金額か消費税等）。CSV・印刷（月次推移は A4 横）
 *  - 確認：申告の前に直すもの・確かめるもの。関係する仕訳を開いて直せる（年で判定するものが多いので、期間によらず年度全体）
 *  - 申告書：方式の比較と、付表・第二表・第一表の数字（TaxReturnView.tsx）
 *  - 中間申告：前年の確定消費税額から、その年の中間申告の回数・期限・額（TaxInterimView.tsx）
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download, Printer, TriangleAlert, CircleAlert, Info } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { Page } from "../../App";
import { useAppContext, useBaseSales, useInterim, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { EntryEditModal } from "../entry/EntryEditModal";
import { ADJUSTMENT_PERIOD, groupByEntry, inPeriods, periodNote } from "../../lib/accounting";
import { PeriodTabs, periodLabel } from "../../components/MonthRange";
import { PrintPreview } from "../../components/PrintPreview";
import { ownerText, periodsText, type PrintDoc, type PrintGroup } from "../../lib/printLayout";
import { shortDate, todayIso, yen } from "../../lib/format";
import { toCsv } from "../../lib/csv";
import { INVOICE_KINDS, TAX_STATUS_OPTIONS, TAX_METHOD_OPTIONS } from "../../constants/tax";
import { classLabel, taxCodeDef, useLabel } from "../../lib/tax";
import { buildTaxSummary, buildTaxTrend, taxChecks, TAX_KIND_LABEL, type TaxIssue, type TaxSummaryRow } from "../../lib/taxSummary";
import { TaxReturnView, useInventory } from "./TaxReturnView";
import * as repo from "../../db/repo";
import type { FixedAsset } from "../../lib/depreciation";
import { TaxInterimView } from "./TaxInterimView";
import { fileLabel } from "../../lib/business";

type View = "summary" | "checks" | "return" | "interim";
/** 集計表の出し方：集計（期間の合計）／月次推移（税区分 × 月） */
type Mode = "table" | "trend";

const invoiceLabel = (r: TaxSummaryRow) =>
  r.invoice ? `${INVOICE_KINDS.find((k) => k.value === r.invoice)!.short}${r.transitional !== null ? `（${r.transitional}%控除）` : ""}` : "";

/** 確認の一覧に出す仕訳の数（多いときは「ほか○件」） */
const MAX_ENTRIES = 20;

/** 消費税の集計と確認の一覧（消費税の画面・決算整理の画面の手順・ホームの「次にやること」） */
export const useTaxIssues = () => {
  const { db, year, accounts, counterparties, taxYears, settings, dataVersion } = useAppContext();
  // 消費税は入れたとおりの明細（税込）から計算する（税抜経理の年も）
  const { rawLines: lines, opening, loading } = useYearData();
  const inventory = useInventory(lines, opening);
  // 固定資産台帳（売却の漏れ・家事と兼用する資産の取得の確かめに使う）
  const [assets, setAssets] = useState<FixedAsset[] | null>(null);
  useEffect(() => {
    repo.getAssets(db).then(setAssets).catch(console.error);
  }, [db, dataVersion]);
  const summary = useMemo(() => buildTaxSummary(lines, accounts, taxYears), [lines, accounts, taxYears]);
  const baseSales = useBaseSales();
  const interim = useInterim();
  const issues = useMemo(
    () => taxChecks({
      year, lines, accounts, counterparties, taxYears, invoiceNo: settings.invoice_no, registeredOn: settings.invoice_registered_on, summary, baseSales, interim, inventory, assets,
    }),
    [year, lines, accounts, counterparties, taxYears, settings.invoice_no, settings.invoice_registered_on, summary, baseSales, interim, inventory, assets],
  );
  return { lines, loading, summary, issues };
};

export const TaxPage = ({ go }: { go: (p: Page) => void }) => {
  const { year, accounts, accountMap, taxYear, taxYears, settings } = useAppContext();
  const { lines, loading, summary, issues } = useTaxIssues();
  const toast = useToast();
  const [view, setView] = useState<View>("summary");
  // 集計表の期間（13 = 決算整理）と出し方
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(ADJUSTMENT_PERIOD);
  const [mode, setMode] = useState<Mode>("table");
  const [showTax, setShowTax] = useState(false);
  const [printing, setPrinting] = useState(false);
  const fullYear = from === 1 && to === ADJUSTMENT_PERIOD;
  const shown = useMemo(
    () => (fullYear ? summary : buildTaxSummary(lines.filter((l) => inPeriods(l, from, to)), accounts, taxYears)),
    [fullYear, summary, lines, from, to, accounts, taxYears],
  );
  const trend = useMemo(() => (mode === "trend" ? buildTaxTrend(lines, accounts, taxYears, from, to) : null), [mode, lines, accounts, taxYears, from, to]);
  const trendHeads = trend ? [...trend.periods.map(periodLabel), "合計"] : [];
  const trendValues = (r: NonNullable<typeof trend>["rows"][number]) => (showTax ? [...r.taxes, r.row.tax] : [...r.amounts, r.row.amount]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const byEntry = useMemo(() => groupByEntry(lines), [lines]);

  const exempt = taxYear.status === "exempt";
  const statusText = [
    TAX_STATUS_OPTIONS.find((o) => o.value === taxYear.status)?.label,
    ...(exempt ? [] : [TAX_METHOD_OPTIONS.find((o) => o.value === taxYear.method)?.label]),
    ...(taxYear.taxable_from ? [`${shortDate(taxYear.taxable_from)}から課税事業者`] : []),
  ].join("・");
  const rowKey = (r: TaxSummaryRow) => `${r.kind}|${r.code}|${r.invoice ?? ""}|${r.transitional ?? ""}|${r.businessClass ?? ""}|${r.purchaseUse ?? ""}`;
  const codeLabel = (r: TaxSummaryRow) =>
    `${taxCodeDef(r.code).label}${r.businessClass === 0 ? "（事業区分不明）" : r.businessClass ? `（${classLabel(r.businessClass)}）` : ""}`
    + `${r.purchaseUse === "unknown" ? "（用途区分なし・共通対応で計算）" : r.purchaseUse ? `（${useLabel(r.purchaseUse)}）` : ""}`;
  const toggle = (k: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    return n;
  });

  const exportCsv = async () => {
    const span = fullYear ? "" : `_${periodLabel(from)}-${periodLabel(to)}`;
    const [name, header, body] = trend
      ? [
        `消費税月次推移_${showTax ? "消費税等" : "税込金額"}`,
        ["区分", "税区分", "インボイス", ...trendHeads],
        trend.rows.map((t) => [TAX_KIND_LABEL[t.row.kind], codeLabel(t.row), invoiceLabel(t.row), ...trendValues(t)]),
      ]
      : [
        "消費税集計表",
        ["区分", "税区分", "インボイス", "科目", "税込金額", "消費税等（参考）", "件数"],
        shown.rows.flatMap((r) => [
          [TAX_KIND_LABEL[r.kind], codeLabel(r), invoiceLabel(r), "（合計）", r.amount, r.tax, r.lines],
          ...r.accounts.map((a) => [TAX_KIND_LABEL[r.kind], codeLabel(r), invoiceLabel(r), accountMap.get(a.account_id)?.name ?? "", a.amount, "", a.lines]),
        ]),
      ];
    const path = await save({ defaultPath: `${name}_${fileLabel(settings)}_${year}${span}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    try {
      await writeTextFile(path, toCsv(header as string[], body as (string | number)[][]));
      toast("CSV を書き出しました");
    } catch (e) {
      toast(`書き出せませんでした：${String(e)}`, "error");
    }
  };

  // 印刷：集計表（科目の内訳つき）か月次推移（A4 横）。表示中の期間で
  const printDoc = useMemo((): PrintDoc | null => {
    if (!printing) return null;
    const head = { owner: ownerText(settings.business_name, settings.owner_name), printedOn: todayIso(), period: periodsText(year, from, to) };
    const label = (r: TaxSummaryRow) => [TAX_KIND_LABEL[r.kind], codeLabel(r), invoiceLabel(r)].filter(Boolean).join("　");
    if (trend) {
      return {
        ...head, title: `消費税の月次推移（${showTax ? "消費税等・参考" : "税込金額"}）`, landscape: true,
        sections: [{
          heading: "",
          columns: [{ label: "区分・税区分", width: 22 }, ...trendHeads.map((h) => ({ label: h, width: 8, align: "right" as const }))],
          groups: trend.rows.map((t): PrintGroup => ({ rows: [{ cells: [label(t.row), ...trendValues(t).map((v) => (v ? yen(v) : ""))] }] })),
        }],
      };
    }
    return {
      ...head, title: "消費税集計表",
      sections: [{
        heading: "",
        columns: [
          { label: "区分・税区分", width: 34 }, { label: "科目", width: 20 }, { label: "税込金額", width: 14, align: "right" },
          { label: "消費税等（参考）", width: 14, align: "right" }, { label: "件数", width: 7, align: "right" },
        ],
        groups: shown.rows.map((r): PrintGroup => ({
          rows: [
            { cells: [label(r), r.accounts.length === 1 ? accountMap.get(r.accounts[0].account_id)?.name ?? "" : `${r.accounts.length} 科目`, yen(r.amount), taxCodeDef(r.code).rate > 0 ? yen(r.tax) : "", String(r.lines)] },
            ...(r.accounts.length > 1
              ? r.accounts.map((a) => ({ kind: "sub" as const, cells: ["", accountMap.get(a.account_id)?.name ?? "", yen(a.amount), "", String(a.lines)] }))
              : []),
          ],
        })),
      }],
    };
  }, [printing]); // eslint-disable-line react-hooks/exhaustive-deps

  const errors = issues.filter((i) => i.level === "error").length;
  const ratio = shown.ratio.value;

  return (
    <div className="page">
      <PageHeader
        title="消費税"
        note={`${year}年：${statusText}。税区分ごとの集計、申告の前に確かめること、申告書の数字を出します。`}
      >
        {view === "summary" && (
          <>
            <PeriodTabs from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
            {periodNote(from, to) && <span className="badge badge-adjust period-note">{periodNote(from, to)}</span>}
          </>
        )}
        <button className="btn ghost" onClick={exportCsv} disabled={view !== "summary" || shown.rows.length === 0} title="表示中の期間の集計表（月次推移なら月次推移）を書き出します">
          <Download size={16} /> CSV
        </button>
        <button className="btn ghost" onClick={() => setPrinting(true)} disabled={view !== "summary" || shown.rows.length === 0} title="表示中の期間の集計表を印刷します（月次推移は A4 横）">
          <Printer size={16} /> 印刷
        </button>
      </PageHeader>

      <div className="filters print-skip">
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={view === "summary"} className={view === "summary" ? "on" : ""} onClick={() => setView("summary")}>集計表</button>
          <button role="tab" aria-selected={view === "checks"} className={view === "checks" ? "on" : ""} onClick={() => setView("checks")}>
            確認{issues.length > 0 && <span className={`count-badge ${errors ? "error" : issues.some((i) => i.level === "warn") ? "warn" : "info"}`}>{issues.length}</span>}
          </button>
          <button role="tab" aria-selected={view === "return"} className={view === "return" ? "on" : ""} onClick={() => setView("return")} disabled={exempt}>申告書</button>
          <button role="tab" aria-selected={view === "interim"} className={view === "interim" ? "on" : ""} onClick={() => setView("interim")} disabled={exempt}>中間申告</button>
        </div>
        {exempt && <span className="muted">{year}年は免税事業者です（事業者設定の「消費税」で変えられます）。</span>}
      </div>

      {view === "return" && !exempt ? (
        <section className="sheet sheet-fill">
          <div className="scroll-y">
            {errors > 0 && <p className="notice print-skip">「確認」に、申告の前に直すものが {errors} 件あります。</p>}
            <TaxReturnView />
          </div>
        </section>
      ) : view === "interim" && !exempt ? (
        <section className="sheet sheet-fill">
          <div className="scroll-y">
            <TaxInterimView onOpenReturn={() => setView("return")} />
          </div>
        </section>
      ) : view === "summary" ? (
        <section className="sheet sheet-fill">
          <div className="tax-mode-bar">
            <div className="seg" role="tablist" aria-label="集計表の出し方">
              <button role="tab" aria-selected={mode === "table"} className={mode === "table" ? "on" : ""} onClick={() => setMode("table")}>集計</button>
              <button role="tab" aria-selected={mode === "trend"} className={mode === "trend" ? "on" : ""} onClick={() => setMode("trend")}>月次推移</button>
            </div>
            {mode === "trend" && (
              <div className="seg" role="tablist" aria-label="月次推移の金額">
                <button role="tab" aria-selected={!showTax} className={!showTax ? "on" : ""} onClick={() => setShowTax(false)}>税込金額</button>
                <button role="tab" aria-selected={showTax} className={showTax ? "on" : ""} onClick={() => setShowTax(true)}>消費税等（参考）</button>
              </div>
            )}
            {!fullYear && <span className="muted">{periodsText(year, from, to)}の明細だけで集計しています。</span>}
          </div>
          {trend ? (
            <div className="table-wrap scroll-y">
              <table className="ledger tax-trend-table">
                <thead>
                  <tr><th>区分</th><th>税区分</th><th>インボイス</th>{trendHeads.map((h) => <th key={h} className="num">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {trend.rows.map((t) => (
                    <tr key={rowKey(t.row)}>
                      <td>{TAX_KIND_LABEL[t.row.kind]}</td>
                      <td>{codeLabel(t.row)}</td>
                      <td>{invoiceLabel(t.row)}</td>
                      {trendValues(t).map((v, i) => <td key={i} className={`num${i === trend.periods.length ? " trend-total" : ""}`}>{v ? yen(v) : ""}</td>)}
                    </tr>
                  ))}
                  {!loading && trend.rows.length === 0 && (
                    <tr className="empty-row"><td colSpan={trendHeads.length + 3}>{exempt ? `${year}年は免税事業者のため、集計するものはありません。` : "この期間に税区分の入った仕訳はありません。"}</td></tr>
                  )}
                </tbody>
              </table>
              {showTax && <p className="field-note">消費税等は参考です（税込金額 × 税率 /（100 + 税率）を月ごとに切り捨て。合計は期間の税込金額から計算するので、月の和と1円ずれることがあります）。</p>}
            </div>
          ) : (
          <div className="table-wrap scroll-y">
            <table className="ledger tax-summary-table">
              <colgroup>
                <col style={{ width: "22%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "14%" }} />
                <col />
                <col style={{ width: "13%" }} />
                <col style={{ width: "13%" }} />
                <col style={{ width: 70 }} />
              </colgroup>
              <thead>
                <tr><th>区分</th><th>税区分</th><th>インボイス</th><th>科目</th><th className="num">税込金額</th><th className="num" title="税込金額 × 税率 /（100 + 税率）の 1 円未満切り捨て。申告の計算とは端数の扱いが違います">消費税等（参考）</th><th className="num">件数</th></tr>
              </thead>
              <tbody>
                {shown.rows.map((r) => {
                  const k = rowKey(r);
                  const isOpen = open.has(k);
                  return (
                    <Fragment key={k}>
                      <tr className="clickable tax-sum-row" onClick={() => toggle(k)} aria-expanded={isOpen}>
                        <td>{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {TAX_KIND_LABEL[r.kind]}</td>
                        <td>{codeLabel(r)}</td>
                        <td>{invoiceLabel(r)}</td>
                        <td className="muted">{r.accounts.length === 1 ? accountMap.get(r.accounts[0].account_id)?.name : `${r.accounts.length} 科目`}</td>
                        <td className="num">{yen(r.amount)}</td>
                        <td className="num">{taxCodeDef(r.code).rate > 0 ? yen(r.tax) : ""}</td>
                        <td className="num muted">{r.lines}</td>
                      </tr>
                      {isOpen && r.accounts.map((a) => (
                        <tr key={a.account_id} className="sub-row">
                          <td /><td /><td />
                          <td>{accountMap.get(a.account_id)?.name}</td>
                          <td className="num">{yen(a.amount)}</td>
                          <td />
                          <td className="num muted">{a.lines}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
                {!loading && shown.rows.length === 0 && (
                  <tr className="empty-row"><td colSpan={7}>{exempt ? `${year}年は免税事業者のため、集計するものはありません。` : fullYear ? "税区分の入った仕訳はまだありません。" : "この期間に税区分の入った仕訳はありません。"}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          )}
          {!exempt && (
            <dl className="kv tax-ratio">
              <dt>課税売上（税抜）</dt><dd className="num">{yen(shown.ratio.taxable)}</dd>
              <dt>輸出免税</dt><dd className="num">{yen(shown.ratio.exportSales)}</dd>
              <dt>非課税売上</dt><dd className="num">{yen(shown.ratio.nontax)}</dd>
              <dt>課税売上割合{fullYear ? "" : "（この期間）"}</dt><dd className="num">{ratio === null ? "—" : `${(Math.floor(ratio * 10000) / 100).toFixed(2)}%`}</dd>
            </dl>
          )}
        </section>
      ) : (
        <section className="sheet sheet-fill">
          <div className="scroll-y">
            {issues.length === 0 ? (
              <p className="empty-note">{exempt ? `${year}年は免税事業者です。` : "確かめることは見つかりませんでした。"}</p>
            ) : (
              <ul className="tax-issues">
                {issues.map((i) => (
                  <IssueCard key={i.title} issue={i} byEntry={byEntry} onOpen={setEditing} go={go} onView={setView} />
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {editing && <EntryEditModal entryId={editing} onClose={() => setEditing(null)} />}
      {printing && <PrintPreview doc={printDoc} onClose={() => setPrinting(false)} />}
    </div>
  );
};

const LEVEL_ICON = { error: <CircleAlert size={16} />, warn: <TriangleAlert size={16} />, info: <Info size={16} /> };
const FIX_LABEL = { settings: "事業者設定を開く", counterparties: "取引先を開く", entries: "", return: "申告書を開く", interim: "中間申告を開く" };

const IssueCard = ({ issue, byEntry, onOpen, go, onView }: {
  issue: TaxIssue;
  byEntry: ReturnType<typeof groupByEntry>;
  onOpen: (id: number) => void;
  go: (p: Page) => void;
  onView: (v: View) => void;
}) => {
  const fix = () => {
    if (issue.fix === "return" || issue.fix === "interim") onView(issue.fix);
    else go(issue.fix === "settings" ? "settings" : "counterparties");
  };
  const { labelOf } = useAppContext();
  const shown = issue.entryIds.slice(0, MAX_ENTRIES);
  return (
    <li className={`tax-issue level-${issue.level}`}>
      <div className="tax-issue-head">
        {LEVEL_ICON[issue.level]}
        <strong>{issue.title}</strong>
        {issue.entryIds.length > 0 && <span className="muted">{issue.entryIds.length} 件</span>}
        <span className="spacer" />
        {issue.fix && issue.fix !== "entries" && (
          <button className="btn ghost sm" onClick={fix}>{FIX_LABEL[issue.fix]}</button>
        )}
      </div>
      <p className="tax-issue-detail">{issue.detail}</p>
      {shown.length > 0 && (
        <table className="ledger tax-issue-entries">
          <tbody>
            {shown.map((id) => {
              const ls = byEntry.get(id) ?? [];
              const dr = ls.filter((l) => l.side === "debit");
              const total = dr.reduce((s, l) => s + l.amount, 0);
              return (
                <tr key={id} className="clickable" onClick={() => onOpen(id)} title="クリックで仕訳を開く">
                  <td style={{ width: 64 }}>{ls[0] ? shortDate(ls[0].date) : ""}</td>
                  <td className="num muted" style={{ width: 56 }}>{id}</td>
                  <td>{dr.map((l) => labelOf(l.account_id, l.sub_account_id)).join("・")}</td>
                  <td className="memo">{ls.find((l) => l.memo)?.memo ?? ""}</td>
                  <td className="num" style={{ width: 120 }}>{yen(total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {issue.entryIds.length > MAX_ENTRIES && <p className="field-note">ほか {issue.entryIds.length - MAX_ENTRIES} 件（仕訳日記帳の「税区分」の絞り込みでも探せます）</p>}
    </li>
  );
};
