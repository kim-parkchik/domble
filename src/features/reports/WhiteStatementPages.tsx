/**
 * 収支内訳書（一般用）の画面（白色申告の年の決算書）
 *  1ページ：収支（①〜㉑）、給料賃金の内訳、税理士・弁護士等の報酬・料金の内訳、事業専従者の氏名等
 *  2ページ：売上（収入）金額・仕入金額の明細、減価償却費の計算、地代家賃・利子割引料の内訳、本年中における特殊事情
 * 数字は lib/whiteStatement.ts（e-Tax のデータと同じ計算）。明細の表と書き込みは青色申告決算書と同じもの（StatementPages.tsx）
 * 事業専従者は、所得税の入力の配偶者・扶養親族のうち「専従者」に印を付けた人（従事月数・仕事の内容もそこで入れる）
 */
import { useEffect, useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { closingBalances } from "../../lib/accounting";
import { yen } from "../../lib/format";
import { EMPTY_INCOME_TAX_INPUT, type IncomeTaxInput } from "../../lib/incomeTax";
import { businessMonths, familyDeductions, familyMembers, whiteSummary } from "../../lib/whiteStatement";
import { isYearCompliant } from "../../lib/ebook";
import * as repo from "../../db/repo";
import {
  DepreciationSection, FeesSection, InterestSection, PartnerSections, PayTable, RentSection, SpecialSection, useAssets, useDetailRows, useNotes,
} from "./StatementPages";
import { ownerText } from "../../lib/printLayout";

type Tab = "p1" | "p2";
const TAB_LABEL: Record<Tab, string> = { p1: "収支・給料・専従者", p2: "売上先・減価償却など" };

const Line = ({ no, label, value, strong, indent }: { no?: string; label: string; value: number; strong?: boolean; indent?: boolean }) => (
  <tr className={strong ? "st-strong" : ""}>
    <td className={indent ? "indent" : ""}>{no && <span className="st-no">{no}</span>}{label}</td>
    <td className={`num${value < 0 ? " negative" : ""}`}>{yen(value)}</td>
  </tr>
);

/** 所得税の入力（事業専従者・事業の期間を使う） */
const useIncomeTaxInput = () => {
  const { db, year, dataVersion } = useAppContext();
  const [x, setX] = useState<IncomeTaxInput>(EMPTY_INCOME_TAX_INPUT);
  useEffect(() => {
    repo.getIncomeTaxInput(db, year).then(setX).catch(console.error);
  }, [db, year, dataVersion]);
  return x;
};

const mmdd = (iso: string) => `${Number(iso.slice(5, 7))}月${Number(iso.slice(8, 10))}日`;

export const WhiteStatements = () => {
  const { year, accounts, settings, closings, strict } = useAppContext();
  const closedHead = strict ? closings.find((c) => c.fiscal_year === year && c.period_end === `${year}-12-31`)?.chain_head : undefined;
  const { lines, opening } = useYearData();
  const { notes, set } = useNotes();
  const rows = useDetailRows(lines);
  const assets = useAssets();
  const input = useIncomeTaxInput();
  const [tab, setTab] = useState<Tab>("p1");

  const end = useMemo(() => closingBalances(accounts, opening, lines), [accounts, opening, lines]);
  const w = useMemo(() => whiteSummary(accounts, (a) => end.get(a.id) ?? 0), [accounts, end]);
  const periodMonths = businessMonths(input.businessTax, year);
  const family = familyDeductions(w.beforeDeduction, familyMembers(input), year, periodMonths);
  const familyDeduction = family.reduce((s, l) => s + l.deduction, 0);

  const change = input.businessTax;
  const changed = change.change && change.changeDate.startsWith(`${year}-`);
  const from = changed && change.change === "open" ? mmdd(change.changeDate) : "1月1日";
  const to = changed && change.change === "close" ? mmdd(change.changeDate) : "12月31日";

  return (
    <div className="page">
      <PageHeader title="決算書（収支内訳書）" note={`${year}年分・白色申告`}>
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

      {w.warnings.length > 0 && <p className="notice print-skip">{w.warnings.join("。")}。</p>}
      <section className="sheet statement print-area">
        <header className="statement-head">
          <h2>収支内訳書（一般用）{tab === "p2" ? "　2ページ" : ""}</h2>
          <p>
            {ownerText(settings.business_name, settings.owner_name)}
            <br />
            {year}年分　事業期間 {from}〜{to}（営業等）
            {closedHead && <><br /><span className="statement-anchor">確認コード {repo.anchorCode(closedHead)}</span></>}
            {!isYearCompliant(settings, year) && <><br /><span className="statement-off">電子帳簿保存法の対応外（通常の保存）</span></>}
          </p>
        </header>

        {tab === "p1" ? (
          <>
            <div className="pl-grid">
              <table className="ledger st-table">
                <tbody>
                  <tr className="cat-row"><td colSpan={2}>収入金額</td></tr>
                  <Line no="①" label="売上（収入）金額" value={w.revenue.sales} indent />
                  <Line no="②" label="家事消費" value={w.revenue.household} indent />
                  <Line no="③" label="その他の収入" value={w.revenue.other} indent />
                  <Line no="④" label="計" value={w.revenue.total} strong />
                  <tr className="cat-row"><td colSpan={2}>売上原価</td></tr>
                  <Line no="⑤" label="期首商品（製品）棚卸高" value={w.cogs.opening} indent />
                  <Line no="⑥" label="仕入金額（製品製造原価）" value={w.cogs.purchases} indent />
                  <Line no="⑦" label="小計" value={w.cogs.subtotal} indent />
                  <Line no="⑧" label="期末商品（製品）棚卸高" value={w.cogs.closing} indent />
                  <Line no="⑨" label="差引原価" value={w.cogs.cost} strong />
                  <Line no="⑩" label="差引金額（④－⑨）" value={w.difference} strong />
                </tbody>
              </table>
              <table className="ledger st-table">
                <tbody>
                  <tr className="cat-row"><td colSpan={2}>経費</td></tr>
                  {w.mainExpenses.map((r) => <Line key={r.no} no={r.no} label={r.label} value={r.amount} indent />)}
                  <tr><td className="indent">その他の経費</td><td /></tr>
                  {w.otherExpenses.map((r) => <Line key={r.no + r.label} no={r.no} label={r.label} value={r.amount} indent />)}
                  <Line no="⑰" label="小計（その他の経費）" value={w.otherSubtotal} indent />
                  <Line no="⑱" label="経費計" value={w.expenseTotal} strong />
                  <Line no="⑲" label="専従者控除前の所得金額（⑩－⑱）" value={w.beforeDeduction} strong />
                  <Line no="⑳" label="専従者控除" value={familyDeduction} indent />
                  <Line no="㉑" label="所得金額（⑲－⑳）" value={w.beforeDeduction - familyDeduction} strong />
                </tbody>
              </table>
            </div>

            <div className="st-pages st-page3">
              <section>
                <h3 className="st-h">給料賃金の内訳</h3>
                <PayTable rows={rows.salaries} prefix="salary" withRelation={false} notes={notes} onSaved={set} />
                <p className="field-note screen-only">氏名は、仕訳の取引先か補助科目から出します（人ごとに補助科目を作っておくと分かれます）。賞与を入れると、合計のうち残りを給料にします。</p>
                <FeesSection rows={rows.fees} notes={notes} onSaved={set} />
              </section>
              <section>
                <h3 className="st-h">事業専従者の氏名等</h3>
                {family.length === 0 ? (
                  <p className="muted">事業専従者はいません。</p>
                ) : (
                  <table className="ledger st-detail">
                    <thead>
                      <tr><th>氏名</th><th className="num">年齢</th><th>続柄</th><th className="num">従事月数</th><th className="screen-only">従事の程度・仕事の内容</th><th className="num">専従者控除</th><th className="screen-only">備考</th></tr>
                    </thead>
                    <tbody>
                      {family.map((l) => (
                        <tr key={l.from}>
                          <td>{l.name}</td>
                          <td className="num">{l.age === null ? "" : `${l.age}歳`}</td>
                          <td>{l.relation}</td>
                          <td className="num">{l.months === null ? "" : `${l.months}か月`}</td>
                          <td className="screen-only">{l.work}</td>
                          <td className="num">{yen(l.deduction)}</td>
                          <td className="screen-only">{l.problem ? <span className="balance-ng">{l.problem}</span> : <span className="muted">{l.spouse ? "配偶者 86万円まで" : "50万円まで"}</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={3}>延べ従事月数・計</td>
                        <td className="num">{family.filter((l) => !l.problem).reduce((s, l) => s + (l.months ?? 0), 0)}か月</td>
                        <td className="screen-only" /><td className="num">{yen(familyDeduction)}</td><td className="screen-only" />
                      </tr>
                    </tfoot>
                  </table>
                )}
                <p className="field-note screen-only">
                  事業専従者は、所得税の画面の配偶者・扶養親族で「専従者」に印を付けた人です（生年月日・従事月数・仕事の内容もそこで入れます）。
                  控除額は1人につき、86万円（配偶者以外は50万円）と ⑲÷（事業専従者の数＋1）の少ない方です。
                  12月31日に15歳以上で、その年に6か月を超えて（年の中途に開業・廃業したときは事業の期間の2分の1を超えて）事業に専ら従事した人が対象です。
                  事業専従者は、配偶者控除・扶養控除の対象になりません。
                </p>
              </section>
            </div>
          </>
        ) : (
          <div className="st-pages st-page3">
            <section>
              <PartnerSections lines={lines} salesTotal={w.revenue.sales} purchaseTotal={w.cogs.purchases} salesOther="上記以外の売上先の計" notes={notes} onSaved={set} />
            </section>
            <section>
              <DepreciationSection assets={assets} notes={notes} onSaved={set} />
            </section>
            <section>
              <RentSection rows={rows.rent} notes={notes} onSaved={set} />
              <InterestSection rows={rows.interest} notes={notes} onSaved={set} />
              <SpecialSection notes={notes} onSaved={set} />
            </section>
          </div>
        )}
      </section>
    </div>
  );
};
