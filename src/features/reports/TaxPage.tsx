/**
 * 消費税：集計表と確認の一覧（計算は lib/taxSummary.ts）
 *  - 集計表：区分（売上・売上の返還・仕入…）× 税区分 × インボイス区分（経過措置は控除できる割合ごと）。行を開くと科目ごとの内訳
 *  - 確認：申告の前に直すもの・確かめるもの。関係する仕訳を開いて直せる
 *  - 申告書：方式の比較と、付表・第二表・第一表の数字（TaxReturnView.tsx）
 *  - 中間申告：前年の確定消費税額から、その年の中間申告の回数・期限・額（TaxInterimView.tsx）
 */
import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download, TriangleAlert, CircleAlert, Info } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { Page } from "../../App";
import { useAppContext, useBaseSales, useInterim, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { EntryEditModal } from "../entry/EntryEditModal";
import { groupByEntry } from "../../lib/accounting";
import { shortDate, yen } from "../../lib/format";
import { toCsv } from "../../lib/csv";
import { INVOICE_KINDS, TAX_STATUS_OPTIONS, TAX_METHOD_OPTIONS } from "../../constants/tax";
import { classLabel, taxCodeDef, useLabel } from "../../lib/tax";
import { buildTaxSummary, taxChecks, TAX_KIND_LABEL, type TaxIssue, type TaxSummaryRow } from "../../lib/taxSummary";
import { TaxReturnView, useInventory } from "./TaxReturnView";
import { TaxInterimView } from "./TaxInterimView";

type View = "summary" | "checks" | "return" | "interim";

const invoiceLabel = (r: TaxSummaryRow) =>
  r.invoice ? `${INVOICE_KINDS.find((k) => k.value === r.invoice)!.short}${r.transitional !== null ? `（${r.transitional}%控除）` : ""}` : "";

/** 確認の一覧に出す仕訳の数（多いときは「ほか○件」） */
const MAX_ENTRIES = 20;

export const TaxPage = ({ go }: { go: (p: Page) => void }) => {
  const { year, accounts, accountMap, counterparties, taxYears, taxYear, settings } = useAppContext();
  const { lines, opening, loading } = useYearData();
  const inventory = useInventory(lines, opening);
  const toast = useToast();
  const [view, setView] = useState<View>("summary");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);

  const summary = useMemo(() => buildTaxSummary(lines, accounts, taxYears), [lines, accounts, taxYears]);
  const baseSales = useBaseSales();
  const interim = useInterim();
  const issues = useMemo(
    () => taxChecks({
      year, lines, accounts, counterparties, taxYears, invoiceNo: settings.invoice_no, registeredOn: settings.invoice_registered_on, summary, baseSales, interim, inventory,
    }),
    [year, lines, accounts, counterparties, taxYears, settings.invoice_no, settings.invoice_registered_on, summary, baseSales, interim, inventory],
  );
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
    const header = ["区分", "税区分", "インボイス", "科目", "税込金額", "消費税等（参考）", "件数"];
    const body = summary.rows.flatMap((r) => [
      [TAX_KIND_LABEL[r.kind], codeLabel(r), invoiceLabel(r), "（合計）", r.amount, r.tax, r.lines],
      ...r.accounts.map((a) => [TAX_KIND_LABEL[r.kind], codeLabel(r), invoiceLabel(r), accountMap.get(a.account_id)?.name ?? "", a.amount, "", a.lines]),
    ]);
    const path = await save({ defaultPath: `消費税集計表_${settings.business_name || "帳簿"}_${year}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    try {
      await writeTextFile(path, toCsv(header, body));
      toast("CSV を書き出しました");
    } catch (e) {
      toast(`書き出せませんでした：${String(e)}`, "error");
    }
  };

  const errors = issues.filter((i) => i.level === "error").length;
  const ratio = summary.ratio.value;

  return (
    <div className="page">
      <PageHeader
        title="消費税"
        note={`${year}年：${statusText}。税区分ごとの集計、申告の前に確かめること、申告書の数字を出します。`}
      >
        <button className="btn ghost" onClick={exportCsv} disabled={summary.rows.length === 0}>
          <Download size={16} /> 集計表の CSV
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
                {summary.rows.map((r) => {
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
                {!loading && summary.rows.length === 0 && (
                  <tr className="empty-row"><td colSpan={7}>{exempt ? `${year}年は免税事業者のため、集計するものはありません。` : "税区分の入った仕訳はまだありません。"}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {!exempt && (
            <dl className="kv tax-ratio">
              <dt>課税売上（税抜）</dt><dd className="num">{yen(summary.ratio.taxable)}</dd>
              <dt>輸出免税</dt><dd className="num">{yen(summary.ratio.exportSales)}</dd>
              <dt>非課税売上</dt><dd className="num">{yen(summary.ratio.nontax)}</dd>
              <dt>課税売上割合</dt><dd className="num">{ratio === null ? "—" : `${(Math.floor(ratio * 10000) / 100).toFixed(2)}%`}</dd>
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
