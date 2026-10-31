/**
 * 決算書
 *  青色申告の年：青色申告決算書に近い形（1ページ：損益計算書 ／ 2〜3ページ：StatementPages.tsx ／ 4ページ：貸借対照表）
 *  白色申告の年：収支内訳書（WhiteStatementPages.tsx）
 */
import { useEffect, useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { closingBalances, summarizeIncome } from "../../lib/accounting";
import { yen } from "../../lib/format";
import * as repo from "../../db/repo";
import type { IncomeKind } from "../../lib/types";
import { BLUE_DEDUCTION_LIMIT } from "../../lib/incomeTax";
import { statementLayout, type StatementLayout } from "../../lib/statementLines";
import { incomeStatementForm, manufacturingForm, type FormRow } from "../../lib/statementForm";
import { monthlySales } from "../../lib/statements";
import { businessPeriod } from "../../lib/incomeTax";
import { BalanceSheetView, BusinessHead, StatementPage2, StatementPage3 } from "./StatementPages";
import { WhiteStatements } from "./WhiteStatementPages";
import { RealEstateStatements } from "./RealEstateStatementPages";
import { isYearCompliant } from "../../lib/ebook";
import { accountsOfKind } from "../../lib/incomeKind";
import { realEstateStatement } from "../../lib/realEstateStatement";
import { ownerText } from "../../lib/printLayout";


type Tab = "pl" | "p2" | "p3" | "bs";

const TAB_LABEL: Record<Tab, string> = { pl: "損益計算書", p2: "月別売上・給料など", p3: "減価償却・地代家賃など", bs: "貸借対照表" };
const TAB_TITLE: Record<Tab, string> = { pl: "損益計算書", p2: "月別売上（収入）金額及び仕入金額 ほか", p3: "減価償却費の計算 ほか", bs: "貸借対照表（資産負債調）" };
const TABS = Object.keys(TAB_LABEL) as Tab[];

export const StatementsPage = () => {
  const { filing, settings } = useAppContext();
  const [kind, setKind] = useState<IncomeKind>("business");
  const white = filing.type === "white";
  // 不動産所得があれば（事業者設定）、事業所得（一般用）と不動産所得用を切り替える
  const hasRealEstate = (settings.real_estate ?? "none") !== "none";
  const body = hasRealEstate && kind === "realestate" ? <RealEstateStatements white={white} /> : white ? <WhiteStatements /> : <BlueStatements />;
  if (!hasRealEstate) return body;
  return (
    <>
      <div className="seg statement-kind print-skip" role="tablist" aria-label="所得の区分">
        {([["business", "事業所得（一般用）"], ["realestate", "不動産所得用"]] as [IncomeKind, string][]).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{label}</button>
        ))}
      </div>
      {body}
    </>
  );
};

const BlueStatements = () => {
  const { db, year, accounts, settings, closings, strict, filing } = useAppContext();
  // 締めたときの確認コード（厳密モード）。印刷した決算書が、帳簿ファイルの外の控えになる
  const closedHead = strict ? closings.find((c) => c.fiscal_year === year && c.period_end === `${year}-12-31`)?.chain_head : undefined;
  const { lines, opening } = useYearData();
  const [tab, setTab] = useState<Tab>("pl");
  // 事業期間（年の中途の開業・廃業。所得税の入力の「事業税に関する事項」から）
  const [period, setPeriod] = useState<{ from: string; to: string }>({ from: "1月1日", to: "12月31日" });
  useEffect(() => {
    repo.getIncomeTaxInput(db, year).then((x) => setPeriod(businessPeriod(x.businessTax, year))).catch(console.error);
  }, [db, year]);

  const end = useMemo(() => closingBalances(accounts, opening, lines), [accounts, opening, lines]);
  // 一般用の決算書は事業所得の科目だけ（不動産所得は不動産所得用の決算書）。貸借対照表は帳簿全体
  const bizAccounts = useMemo(() => accountsOfKind(accounts, "business"), [accounts]);
  const pl = summarizeIncome(bizAccounts, end);

  // 決算書の欄（勘定科目の画面の「決算書の欄」で選べる。e-Tax 用のデータと同じ）
  const layout = useMemo(() => statementLayout(bizAccounts, (a) => end.get(a.id) ?? 0, (a) => opening[a.id] ?? 0), [bizAccounts, end, opening]);
  const layoutWarnings = layout.warnings;
  const monthlyPurchases = useMemo(() => monthlySales(bizAccounts, lines).purchases.reduce((s, x) => s + x, 0), [bizAccounts, lines]);

  const limit = BLUE_DEDUCTION_LIMIT[filing.type];
  // 青色申告特別控除は不動産所得から先に差し引く
  // 不動産所得は不動産所得用の決算書と同じ計算（専従者給与は事業的規模のときだけ必要経費）
  const scale = settings.real_estate ?? "none";
  const realEstateIncome = Math.max(0, realEstateStatement(accounts, (a) => end.get(a.id) ?? 0, "blue", { familyAllowed: scale === "business", deductionLimit: 0 }).beforeDeduction);
  const deduction = Math.min(limit - Math.min(limit, realEstateIncome), Math.max(0, pl.income));
  const form = incomeStatementForm(layout, pl.revenue, deduction);

  /** 4ページまとめて印刷（画面は表示中のページのまま） */
  const printAll = () => {
    document.body.classList.add("st-print-all");
    const done = () => {
      document.body.classList.remove("st-print-all");
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
  };

  const head = (t: Tab) => (
    <header className="statement-head">
      <h2 className={t === "p2" || t === "p3" ? "st-title-small" : ""}>{TAB_TITLE[t]}</h2>
      <p>
        {t !== "pl" && <>{ownerText(settings.business_name, settings.owner_name)}<br /></>}
        {t === "bs" ? `${year}年12月31日 現在` : `自 ${year}年${period.from}　至 ${year}年${period.to}`}
        {closedHead && <><br /><span className="statement-anchor">確認コード {repo.anchorCode(closedHead)}</span></>}
        {!isYearCompliant(settings, year) && <><br /><span className="statement-off">電子帳簿保存法の対応外（通常の保存）</span></>}
      </p>
    </header>
  );

  return (
    <div className="page">
      <PageHeader title="決算書" note={`${year}年1月1日〜${year}年12月31日`}>
        <div className="seg" role="tablist">
          {TABS.map((t, i) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {i + 1}. {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <button className="btn ghost" onClick={() => window.print()} title="表示中のページを印刷します">
          <Printer size={16} /> 印刷
        </button>
        <button className="btn ghost" onClick={printAll} title="1〜4ページをまとめて印刷します">
          <Printer size={16} /> まとめて印刷
        </button>
      </PageHeader>

      {layoutWarnings.length > 0 && (
        <p className="notice print-skip">
          {layoutWarnings.join("。")}（決算書と e-Tax 用のデータ）。勘定科目の画面の「決算書の欄」で、書く欄を選び直せます。
        </p>
      )}
      {TABS.map((t) => (
        <section key={t} className={`sheet statement print-area st-page${tab === t ? "" : " st-off"}`}>
          {head(t)}
          {t === "pl" ? (
            <>
              <BusinessHead kind="general" period={period} year={year} />
              <div className="pl-grid">
                <FormTable rows={form.left} />
                <FormTable rows={form.right} />
              </div>
              {form.beforeDeduction !== pl.income && (
                <p className="warn-box" role="alert">㊸ が帳簿の所得（{yen(pl.income)}円）と合いません。勘定科目の「決算書の欄」を確かめてください。</p>
              )}
              <p className="field-note screen-only">
                欄に入れた科目は、欄の名前と違うものだけ小さく添えています（印刷には出ません）。㊹ 青色申告特別控除額は、2ページの「青色申告特別控除額の計算」で出した額です（上限は申告の種類による {yen(limit)}円。不動産所得から先に差し引きます）。
              </p>
            </>
          ) : t === "p2" ? (
            <StatementPage2 lines={lines} income={pl.income} deductionLimit={limit} realEstateIncome={realEstateIncome} end={end} opening={opening} />
          ) : t === "p3" ? (
            <StatementPage3 lines={lines} salesTotal={pl.revenue} purchaseTotal={monthlyPurchases} />
          ) : (
            <>
              <BalanceSheetView end={end} opening={opening} />
              {layout.hasManufacturing && <ManufacturingView layout={layout} />}
            </>
          )}
        </section>
      ))}
    </div>
  );
};

/** 様式の行の表（番号・欄・金額）。欄に入れた科目は、欄の名前と違うものだけ画面に小さく添える */
const FormTable = ({ rows }: { rows: FormRow[] }) => {
  const { accountMap } = useAppContext();
  const names = (r: FormRow) => (r.accountIds ?? []).map((id) => accountMap.get(id)?.name ?? "").filter((n) => n && n !== r.label);
  return (
    <table className="ledger st-table st-form">
      <colgroup><col className="st-no-col" /><col /><col className="st-amount-col" /></colgroup>
      <tbody>
        {rows.map((r, i) => r.kind === "head" ? (
          <tr key={i} className="cat-row"><td colSpan={3}>{r.label}</td></tr>
        ) : (
          <tr key={i} className={r.kind === "total" ? "st-strong" : ""}>
            <td className="st-no">{r.no}</td>
            <td>
              {r.label}
              {names(r).length > 0 && <span className="st-accounts screen-only">{names(r).join("・")}</span>}
            </td>
            <td className={`num${r.amount != null && r.amount < 0 ? " negative" : ""}`}>{r.amount == null ? "" : yen(r.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** 4ページの製造原価の計算（①〜㉖。㉖ は1ページの ③ へ） */
const ManufacturingView = ({ layout }: { layout: StatementLayout }) => {
  const m = manufacturingForm(layout);
  return (
    <div className="st-mfg">
      <h3 className="st-h">製造原価の計算</h3>
      <FormTable rows={m.rows} />
      <p className="field-note screen-only">勘定科目の「決算書の欄」で製造原価の欄を選んだ売上原価の科目から作ります。㉖ 製品製造原価は1ページの ③ に入れています。</p>
    </div>
  );
};
