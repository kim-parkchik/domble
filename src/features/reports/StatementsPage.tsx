/**
 * 決算書
 *  青色申告の年：青色申告決算書に近い形（1ページ：損益計算書 ／ 2〜3ページ：StatementPages.tsx ／ 4ページ：貸借対照表）
 *  白色申告の年：収支内訳書（WhiteStatementPages.tsx）
 */
import { useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { closingBalances, summarizeIncome } from "../../lib/accounting";
import { yen } from "../../lib/format";
import * as repo from "../../db/repo";
import type { Account, IncomeKind } from "../../lib/types";
import { BLUE_DEDUCTION_LIMIT } from "../../lib/incomeTax";
import { statementLayout } from "../../lib/statementLines";
import { BalanceSheetView, StatementPage2, StatementPage3 } from "./StatementPages";
import { WhiteStatements } from "./WhiteStatementPages";
import { RealEstateStatements } from "./RealEstateStatementPages";
import { isYearCompliant } from "../../lib/ebook";
import { accountsOfKind } from "../../lib/incomeKind";
import { realEstateStatement } from "../../lib/realEstateStatement";


type Tab = "pl" | "p2" | "p3" | "bs";

const TAB_LABEL: Record<Tab, string> = { pl: "損益計算書", p2: "月別売上・給料など", p3: "減価償却・地代家賃など", bs: "貸借対照表" };
const TAB_TITLE: Record<Tab, string> = { pl: "損益計算書", p2: "月別売上（収入）金額及び仕入金額 ほか", p3: "減価償却費の計算 ほか", bs: "貸借対照表" };

const Line = ({ label, value, strong, indent }: { label: string; value: number | null; strong?: boolean; indent?: boolean }) => (
  <tr className={strong ? "st-strong" : ""}>
    <td className={indent ? "indent" : ""}>{label}</td>
    <td className={`num${value != null && value < 0 ? " negative" : ""}`}>{value == null ? "" : yen(value)}</td>
  </tr>
);

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
  const { year, accounts, settings, closings, strict, filing } = useAppContext();
  // 締めたときの確認コード（厳密モード）。印刷した決算書が、帳簿ファイルの外の控えになる
  const closedHead = strict ? closings.find((c) => c.fiscal_year === year && c.period_end === `${year}-12-31`)?.chain_head : undefined;
  const { lines, opening } = useYearData();
  const [tab, setTab] = useState<Tab>("pl");

  const end = useMemo(() => closingBalances(accounts, opening, lines), [accounts, opening, lines]);
  // 一般用の決算書は事業所得の科目だけ（不動産所得は不動産所得用の決算書）。貸借対照表は帳簿全体
  const bizAccounts = useMemo(() => accountsOfKind(accounts, "business"), [accounts]);
  const pl = summarizeIncome(bizAccounts, end);
  const by = (cat: Account["category"]) => bizAccounts.filter((a) => a.category === cat);
  const val = (a: Account) => end.get(a.id) ?? 0;

  // e-Tax 用のデータの決算書では、追加の欄に上限がある（勘定科目の画面の「決算書の欄」で選べる）
  const layout = useMemo(() => statementLayout(bizAccounts, (a) => end.get(a.id) ?? 0, (a) => opening[a.id] ?? 0), [bizAccounts, end, opening]);
  const layoutWarnings = layout.warnings;
  const purchaseTotal = layout.sections.cogs.find((r) => r.label === "仕入金額（製品製造原価）")?.amount ?? 0;

  const limit = BLUE_DEDUCTION_LIMIT[filing.type];
  // 青色申告特別控除は不動産所得から先に差し引く
  // 不動産所得は不動産所得用の決算書と同じ計算（専従者給与は事業的規模のときだけ必要経費）
  const scale = settings.real_estate ?? "none";
  const realEstateIncome = Math.max(0, realEstateStatement(accounts, (a) => end.get(a.id) ?? 0, "blue", { familyAllowed: scale === "business", deductionLimit: 0 }).beforeDeduction);
  const deduction = Math.min(limit - Math.min(limit, realEstateIncome), Math.max(0, pl.income));

  const cogs = by("cogs");
  const cogsDebit = cogs.filter((a) => a.normal_side === "debit");
  const cogsCredit = cogs.filter((a) => a.normal_side === "credit");
  const cogsSubtotal = cogsDebit.reduce((s, a) => s + val(a), 0);

  // 各種引当金・準備金等：繰戻額等（貸方の科目。所得に足す）と繰入額等（借方の科目。所得から差し引く）
  const specialBack = by("special").filter((a) => a.normal_side === "credit" && (a.is_active || val(a) !== 0));
  const specialAdd = by("special").filter((a) => a.normal_side === "debit" && (a.is_active || val(a) !== 0));

  return (
    <div className="page">
      <PageHeader title="決算書" note={`${year}年1月1日〜${year}年12月31日`}>
        <div className="seg" role="tablist">
          {(Object.keys(TAB_LABEL) as Tab[]).map((t, i) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {i + 1}. {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <button className="btn ghost" onClick={() => window.print()}>
          <Printer size={16} /> 印刷
        </button>
      </PageHeader>

      {layoutWarnings.length > 0 && (
        <p className="notice print-skip">
          {layoutWarnings.join("。")}（e-Tax 用のデータの決算書）。勘定科目の画面の「決算書の欄」で、書く欄を選び直せます。
        </p>
      )}
      <section className="sheet statement print-area">
        <header className="statement-head">
          <h2 className={tab === "p2" || tab === "p3" ? "st-title-small" : ""}>{TAB_TITLE[tab]}</h2>
          <p>
            {settings.business_name || "（屋号未設定）"}　{settings.owner_name}
            <br />
            {tab === "bs" ? `${year}年12月31日 現在` : `自 ${year}年1月1日　至 ${year}年12月31日`}
            {closedHead && <><br /><span className="statement-anchor">確認コード {repo.anchorCode(closedHead)}</span></>}
            {!isYearCompliant(settings, year) && <><br /><span className="statement-off">電子帳簿保存法の対応外（通常の保存）</span></>}
          </p>
        </header>

        {tab === "p2" ? (
          <StatementPage2 lines={lines} income={pl.income} deductionLimit={limit} realEstateIncome={realEstateIncome} end={end} opening={opening} />
        ) : tab === "p3" ? (
          <StatementPage3 lines={lines} salesTotal={pl.revenue} purchaseTotal={purchaseTotal} />
        ) : tab === "pl" ? (
          <div className="pl-grid">
            <table className="ledger st-table">
              <tbody>
                <tr className="cat-row"><td colSpan={2}>売上（収入）金額</td></tr>
                {by("revenue").map((a) => <Line key={a.id} label={a.name} value={val(a)} indent />)}
                <Line label="売上（収入）金額 計" value={pl.revenue} strong />

                <tr className="cat-row"><td colSpan={2}>売上原価</td></tr>
                {cogsDebit.map((a) => <Line key={a.id} label={a.name} value={val(a)} indent />)}
                <Line label="小計" value={cogsSubtotal} indent />
                {cogsCredit.map((a) => <Line key={a.id} label={a.name} value={val(a)} indent />)}
                <Line label="差引原価" value={pl.cogs} strong />
                <Line label="差引金額（売上総利益）" value={pl.grossProfit} strong />
              </tbody>
            </table>

            <table className="ledger st-table">
              <tbody>
                <tr className="cat-row"><td colSpan={2}>経費</td></tr>
                {by("expense").filter((a) => a.is_active || val(a) !== 0).map((a) => (
                  <Line key={a.id} label={a.name} value={val(a)} indent />
                ))}
                <Line label="経費 計" value={pl.expenses} strong />
                <Line label="差引金額" value={pl.beforeSpecial} strong />
                <tr className="cat-row"><td colSpan={2}>各種引当金・準備金等</td></tr>
                {specialBack.map((a) => <Line key={a.id} label={`繰戻額等　${a.name}`} value={val(a)} indent />)}
                <Line label="繰戻額等 計" value={specialBack.reduce((s, a) => s + val(a), 0)} indent />
                {specialAdd.map((a) => <Line key={a.id} label={`繰入額等　${a.name}`} value={val(a)} indent />)}
                <Line label="繰入額等 計" value={specialAdd.reduce((s, a) => s + val(a), 0)} indent />
                <Line label="青色申告特別控除前の所得金額" value={pl.income} strong />
                <Line label="青色申告特別控除額（目安）" value={deduction} indent />
                <Line label="所得金額" value={pl.income - deduction} strong />
              </tbody>
            </table>
          </div>
        ) : (
          <BalanceSheetView end={end} opening={opening} />
        )}
      </section>
    </div>
  );
};

