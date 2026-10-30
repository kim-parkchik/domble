/**
 * 決算書
 *  青色申告の年：青色申告決算書に近い形（1ページ：損益計算書 ／ 2〜3ページ：StatementPages.tsx ／ 4ページ：貸借対照表）
 *  白色申告の年：収支内訳書（WhiteStatementPages.tsx）
 */
import { useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { closingBalances, summarizeBalanceSheet, summarizeIncome } from "../../lib/accounting";
import { yen } from "../../lib/format";
import * as repo from "../../db/repo";
import type { Account } from "../../lib/types";
import { BLUE_DEDUCTION_LIMIT } from "../../lib/incomeTax";
import { statementLayout } from "../../lib/statementLines";
import { StatementPage2, StatementPage3 } from "./StatementPages";
import { WhiteStatements } from "./WhiteStatementPages";
import { isYearCompliant } from "../../lib/ebook";
import { accountsOfKind } from "../../lib/incomeKind";


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
  const { filing } = useAppContext();
  return filing.type === "white" ? <WhiteStatements /> : <BlueStatements />;
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
  const bs = summarizeBalanceSheet(accounts, end);
  const by = (cat: Account["category"]) => bizAccounts.filter((a) => a.category === cat);
  const val = (a: Account) => end.get(a.id) ?? 0;
  const open = (a: Account) => opening[a.id] ?? 0;

  // e-Tax 用のデータの決算書では、追加の欄に上限がある（勘定科目の画面の「決算書の欄」で選べる）
  const layout = useMemo(() => statementLayout(bizAccounts, (a) => end.get(a.id) ?? 0, (a) => opening[a.id] ?? 0), [bizAccounts, end, opening]);
  const layoutWarnings = layout.warnings;
  const purchaseTotal = layout.sections.cogs.find((r) => r.label === "仕入金額（製品製造原価）")?.amount ?? 0;

  const limit = BLUE_DEDUCTION_LIMIT[filing.type];
  // 青色申告特別控除は不動産所得から先に差し引く
  const realEstateIncome = Math.max(0, summarizeIncome(accountsOfKind(accounts, "realestate"), end).income);
  const deduction = Math.min(limit - Math.min(limit, realEstateIncome), Math.max(0, pl.income));

  const cogs = by("cogs");
  const cogsDebit = cogs.filter((a) => a.normal_side === "debit");
  const cogsCredit = cogs.filter((a) => a.normal_side === "credit");
  const cogsSubtotal = cogsDebit.reduce((s, a) => s + val(a), 0);

  const showRow = (a: Account) => a.is_active || val(a) !== 0 || open(a) !== 0;
  // 各種引当金・準備金等：繰戻額等（貸方の科目。所得に足す）と繰入額等（借方の科目。所得から差し引く）
  const specialBack = by("special").filter((a) => a.normal_side === "credit" && (a.is_active || val(a) !== 0));
  const specialAdd = by("special").filter((a) => a.normal_side === "debit" && (a.is_active || val(a) !== 0));
  const assets = by("asset").filter(showRow);
  const liabilities = by("liability").filter(showRow);
  const equity = by("equity");
  const openAssetsTotal = assets.reduce((s, a) => s + open(a), 0);
  const openRightTotal = [...liabilities, ...equity].reduce((s, a) => s + open(a), 0);

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
          <>
            <div className="bs-grid">
              <table className="ledger st-table bs-table">
                <thead>
                  <tr><th>資産の部</th><th className="num">1月1日（期首）</th><th className="num">12月31日（期末）</th></tr>
                </thead>
                <tbody>
                  {assets.map((a) => (
                    <tr key={a.id}>
                      <td>{a.name}</td>
                      <td className="num">{yen(open(a), { blankZero: true })}</td>
                      <td className={`num${val(a) < 0 ? " negative" : ""}`}>{yen(val(a), { blankZero: true })}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td>合計</td><td className="num">{yen(openAssetsTotal)}</td><td className="num">{yen(bs.assets)}</td></tr>
                </tfoot>
              </table>

              <table className="ledger st-table bs-table">
                <thead>
                  <tr><th>負債・資本の部</th><th className="num">1月1日（期首）</th><th className="num">12月31日（期末）</th></tr>
                </thead>
                <tbody>
                  {[...liabilities, ...equity].map((a) => (
                    <tr key={a.id}>
                      <td>{a.name}</td>
                      <td className="num">{yen(open(a), { blankZero: true })}</td>
                      <td className={`num${val(a) < 0 ? " negative" : ""}`}>{yen(val(a), { blankZero: true })}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>青色申告特別控除前の所得金額</td>
                    <td className="num" />
                    <td className={`num${bs.income < 0 ? " negative" : ""}`}>{yen(bs.income)}</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <td>合計</td>
                    <td className="num">{yen(openRightTotal)}</td>
                    <td className="num">{yen(bs.liabilities + bs.equity + bs.income)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {bs.difference !== 0 && (
              <p className="warn-box" role="alert">
                資産と負債・資本の合計が {yen(Math.abs(bs.difference))} 円ずれています。「期首残高」の貸借が一致しているか確認してください。
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
};
