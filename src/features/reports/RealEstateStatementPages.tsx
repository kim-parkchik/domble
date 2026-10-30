/**
 * 不動産所得用の決算書の画面（数字は lib/realEstateStatement.ts。e-Tax のデータと同じ計算）
 *  青色申告決算書（不動産所得用）：1ページ 損益計算書 ／ 2ページ 不動産所得の収入の内訳・給料賃金・専従者給与 ／
 *    3ページ 減価償却費の計算（貸付割合）・地代家賃・借入金利子の内訳 ／ 4ページ 貸借対照表（事業所得が無いときだけ。あれば一般用に書く）
 *  収支内訳書（不動産所得用）：1ページ 収支・不動産所得の収入の内訳・給料賃金 ／ 2ページ 減価償却費・借入金利子・修繕費・地代家賃の内訳、貸付不動産の保有状況、特殊事情
 * 帳簿から出せない項目（貸家貸地等の別・用途・所在地・契約期間・面積・月額・保証金、借入金の残高など）は書き込み（statement_notes。re- で始まる鍵）
 */
import { useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { closingBalances, summarizeIncome } from "../../lib/accounting";
import { yen } from "../../lib/format";
import { accountsOfKind } from "../../lib/incomeKind";
import { realEstateDeductionLimit, realEstateStatement, rentIncomeRows, type RealEstateStatement, type RentIncomeRow } from "../../lib/realEstateStatement";
import { payeeBreakdown } from "../../lib/statements";
import { isYearCompliant } from "../../lib/ebook";
import { CODE } from "../../constants/accounts";
import type { Account } from "../../lib/types";
import type { FlatLine } from "../../lib/accounting";
import * as repo from "../../db/repo";
import {
  BalanceSheetView, DepreciationSection, InterestSection, Note, PayTable, RentSection, SpecialSection, useAssets, useNotes, usePayeeName, useRunIds, type NoteProps,
} from "./StatementPages";

const Line = ({ no, label, value, strong, indent }: { no?: string; label: string; value: number; strong?: boolean; indent?: boolean }) => (
  <tr className={strong ? "st-strong" : ""}>
    <td className={indent ? "indent" : ""}>{no && <span className="st-no">{no}</span>}{label}</td>
    <td className={`num${value < 0 ? " negative" : ""}`}>{yen(value)}</td>
  </tr>
);

/** 不動産所得の科目の支払先の内訳（給料賃金・専従者給与・地代家賃・借入金利子・修繕費） */
const useReRows = (lines: FlatLine[]) => {
  const { accounts, homeUseRates } = useAppContext();
  const runIds = useRunIds();
  const idOf = (code: string) => accounts.find((a) => a.code === code)?.id ?? 0;
  const drawId = idOf(CODE.OWNER_DRAW);
  const rows = (code: string) => {
    const id = idOf(code);
    if (!id) return [];
    const rate = homeUseRates.find((r) => r.account_id === id && r.method === "yearend");
    return payeeBreakdown(id, lines, { drawId, yearEndRate: rate?.rate ?? null, excludeEntryIds: runIds });
  };
  return {
    salaries: rows(CODE.RE_SALARIES), family: rows(CODE.RE_FAMILY_SALARY), rent: rows(CODE.RE_RENT), interest: rows(CODE.RE_INTEREST), repair: rows(CODE.RE_REPAIR),
  };
};

/** 不動産所得の収入の内訳（賃借人ごと。金額は帳簿から、そのほかは書き込み） */
const RentIncomeSection = ({ rows, notes, onSaved }: NoteProps & { rows: RentIncomeRow[] }) => {
  const payeeName = usePayeeName();
  const k = (r: RentIncomeRow, f: string) => `re-income:${r.key}:${f}`;
  const sum = (f: "rent" | "keyMoney" | "other") => rows.reduce((s, r) => s + r[f], 0);
  return (
    <>
      <h3 className="st-h">不動産所得の収入の内訳</h3>
      {rows.length === 0 ? <p className="muted">賃貸料などの収入はありません。</p> : (
        <div className="table-wrap">
          <table className="ledger st-detail st-re-income">
            <thead>
              <tr>
                <th>貸家・貸地等の別</th><th>用途</th><th>不動産の所在地</th><th>賃借人の住所・氏名</th><th>賃貸契約期間</th><th>貸付面積（㎡）</th>
                <th className="num">賃貸料（月額）</th><th className="num">賃貸料（年額）</th><th className="num">礼金・権利金・更新料</th><th className="num">名義書換料その他</th>
                <th className="num">保証金・敷金（期末残高）</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td><Note k={k(r, "kind")} notes={notes} onSaved={onSaved} placeholder="例：アパート" /></td>
                  <td><Note k={k(r, "use")} notes={notes} onSaved={onSaved} placeholder="住宅用" short /></td>
                  <td><Note k={k(r, "location")} notes={notes} onSaved={onSaved} placeholder="所在地" wide /></td>
                  <td>{r.key === "none" ? "（賃借人の指定なし）" : payeeName(r)}<Note k={k(r, "address")} notes={notes} onSaved={onSaved} placeholder="住所（所在地と同じなら空）" wide /></td>
                  <td><Note k={k(r, "from")} notes={notes} onSaved={onSaved} placeholder="自 2024-04" short /><Note k={k(r, "to")} notes={notes} onSaved={onSaved} placeholder="至 2026-03" short /></td>
                  <td><Note k={k(r, "area")} notes={notes} onSaved={onSaved} placeholder="面積" align="right" short /></td>
                  <td><Note k={k(r, "monthly")} notes={notes} onSaved={onSaved} placeholder="月額" align="right" /></td>
                  <td className="num">{yen(r.rent)}</td>
                  <td className="num">{yen(r.keyMoney, { blankZero: true })}</td>
                  <td className="num">{yen(r.other, { blankZero: true })}</td>
                  <td><Note k={k(r, "deposit")} notes={notes} onSaved={onSaved} placeholder="保証金" align="right" /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7}>計</td>
                <td className="num">{yen(sum("rent"))}</td><td className="num">{yen(sum("keyMoney"))}</td><td className="num">{yen(sum("other"))}</td><td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="field-note screen-only">
        賃借人は、賃貸料などの仕訳の取引先（無ければ補助科目）で分けます。貸家・貸店舗・アパート・貸地・駐車場などの別、用途（住宅用・住宅用以外など）、所在地、契約期間、月額、保証金・敷金はここで書き込みます。
      </p>
    </>
  );
};

/** 修繕費の内訳（収支内訳書（不動産所得用）） */
const RepairSection = ({ rows, notes, onSaved }: NoteProps & { rows: ReturnType<typeof useReRows>["repair"] }) => {
  const payeeName = usePayeeName();
  return (
    <>
      <h3 className="st-h">修繕費の内訳</h3>
      {rows.length === 0 ? <p className="muted">修繕費（不動産）の支払いはありません。</p> : (
        <table className="ledger st-detail">
          <thead><tr><th>支払先の住所・氏名</th><th>工事名又は資材の品名</th><th>支払年月日</th><th className="num">支払金額</th><th className="num">左のうち必要経費算入額</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{payeeName(r)}<Note k={`re-repair:${r.key}:address`} notes={notes} onSaved={onSaved} placeholder="住所" wide /></td>
                <td><Note k={`re-repair:${r.key}:work`} notes={notes} onSaved={onSaved} placeholder="例：外壁塗装" /></td>
                <td><Note k={`re-repair:${r.key}:date`} notes={notes} onSaved={onSaved} placeholder="2026-07-10" short /></td>
                <td className="num">{yen(r.gross)}</td>
                <td className="num">{yen(r.business)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
};

/** 貸付不動産の保有状況（収支内訳書（不動産所得用）。書き込み） */
const HOLDING: [string, string][] = [
  ["house-detached", "住宅用・建物（一戸建）の戸数"], ["house-other", "住宅用・建物（一戸建以外）の室数"], ["house-land-count", "住宅用・土地の契約件数"], ["house-land-area", "住宅用・土地の総面積（㎡）"],
  ["other-detached", "住宅用以外・建物（一戸建）の戸数"], ["other-other", "住宅用以外・建物（一戸建以外）の室数"], ["other-land-count", "住宅用以外・土地の契約件数"],
  ["other-land-area", "住宅用以外・土地の総面積（㎡）"], ["parking-roof", "駐車場（屋根付）の台数"], ["parking-open", "駐車場（青空）の台数"],
];
const HoldingSection = ({ notes, onSaved }: NoteProps) => (
  <>
    <h3 className="st-h">貸付不動産の保有状況</h3>
    <table className="ledger st-detail">
      <tbody>
        {HOLDING.map(([key, label]) => (
          <tr key={key}><td>{label}</td><td><Note k={`re-holding:${key}`} notes={notes} onSaved={onSaved} placeholder="0" align="right" short /></td></tr>
        ))}
      </tbody>
    </table>
  </>
);

/** 1ページの収支（青色：損益計算書 ／ 白色：収支内訳） */
const ProfitTable = ({ st, notes, onSaved }: NoteProps & { st: RealEstateStatement }) => {
  const blue = st.form === "blue";
  const r = st.revenue;
  return (
    <>
      <div className="pl-grid">
        <table className="ledger st-table">
          <tbody>
            <tr className="cat-row"><td colSpan={2}>収入金額</td></tr>
            <Line no="①" label="賃貸料" value={r.rent} indent />
            <Line no="②" label={blue ? "礼金・権利金・更新料" : "礼金・権利金更新料"} value={r.keyMoney} indent />
            <Line no="③" label={r.otherLabel} value={r.other} indent />
            {blue ? <Line no="④" label="計" value={r.total} strong /> : (
              <>
                <Line no="④" label="小計（②＋③）" value={r.keyMoney + r.other} indent />
                <Line no="⑤" label="計" value={r.total} strong />
              </>
            )}
            <tr className="cat-row"><td colSpan={2}>必要経費</td></tr>
            {st.main.map((l) => <Line key={l.no + l.label} no={l.no} label={l.label} value={l.amount} indent />)}
            {!blue && <tr><td className="indent">その他の経費</td><td /></tr>}
            {st.others.map((l) => <Line key={l.no + l.label} no={l.no} label={l.label} value={l.amount} indent />)}
            {blue ? <Line no="⑰" label="その他の経費" value={st.otherTotal} indent /> : <Line no="⑪" label="小計（その他の経費）" value={st.otherTotal} indent />}
            <Line no={blue ? "⑱" : "⑫"} label={blue ? "計" : "経費計"} value={st.expenseTotal} strong />
          </tbody>
        </table>
        <table className="ledger st-table">
          <tbody>
            {blue ? (
              <>
                <Line no="⑲" label="差引金額（④－⑱）" value={st.difference} strong />
                <Line no="⑳" label="専従者給与" value={st.family} indent />
                <Line no="㉑" label="青色申告特別控除前の所得金額（⑲－⑳）" value={st.beforeDeduction} strong />
                <Line no="㉒" label="青色申告特別控除額" value={st.deduction} indent />
                <Line no="㉓" label="所得金額（㉑－㉒）" value={st.income} strong />
              </>
            ) : (
              <>
                <Line no="⑬" label="専従者控除前の所得金額（⑤－⑫）" value={st.difference} strong />
                <Line no="⑭" label="専従者控除" value={0} indent />
                <Line no="⑮" label="所得金額（⑬－⑭）" value={st.income} strong />
              </>
            )}
            <tr>
              <td className="indent">土地等を取得するために要した負債の利子の額</td>
              <td className="num"><Note k="re:landInterest" notes={notes} onSaved={onSaved} placeholder="0" align="right" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="field-note screen-only">
        科目は「（不動産）」を除いた名前で欄に当てます（例：租税公課（不動産）→ 租税公課）。当たらない経費は追加の欄（{blue ? "⑫〜⑯" : "㋥"}）に書きます。
        所得金額が赤字で、必要経費に土地等を取得するための借入金の利子が入っているときは、その額を書き込みます（その額までの赤字はほかの所得から差し引けません。所得税の第一表 ③ に反映します）。
        {blue && " 青色申告特別控除は不動産所得から先に差し引きます（事業所得が無く、事業的規模でない貸付けなら 10万円まで）。"}
      </p>
    </>
  );
};

type Tab = "p1" | "p2" | "p3" | "bs";

export const RealEstateStatements = ({ white }: { white: boolean }) => {
  const { year, accounts, settings, filing, closings, strict } = useAppContext();
  const closedHead = strict ? closings.find((c) => c.fiscal_year === year && c.period_end === `${year}-12-31`)?.chain_head : undefined;
  const { lines, opening } = useYearData();
  const { notes, set } = useNotes();
  const rows = useReRows(lines);
  const assets = useAssets("realestate");
  const [tab, setTab] = useState<Tab>("p1");

  const end = useMemo(() => closingBalances(accounts, opening, lines), [accounts, opening, lines]);
  const scale = settings.real_estate ?? "none";
  const biz = summarizeIncome(accountsOfKind(accounts, "business"), end);
  // 事業所得があれば、貸借対照表は一般用の決算書に書く
  const hasBusiness = biz.revenue !== 0 || biz.income !== 0;
  const st = useMemo(() => realEstateStatement(accounts, (a: Account) => end.get(a.id) ?? 0, white ? "white" : "blue", {
    familyAllowed: !white && scale === "business", deductionLimit: white ? 0 : realEstateDeductionLimit(filing.type, scale, hasBusiness),
  }), [accounts, end, white, scale, filing.type, hasBusiness]);
  const income = useMemo(() => rentIncomeRows(accounts, lines), [accounts, lines]);

  const tabs: [Tab, string][] = white
    ? [["p1", "収支・収入の内訳"], ["p2", "減価償却・修繕費など"]]
    : [["p1", "損益計算書"], ["p2", "収入の内訳・給料"], ["p3", "減価償却・借入金利子など"], ...(hasBusiness ? [] : [["bs", "貸借対照表"] as [Tab, string]])];
  const title = white ? "収支内訳書（不動産所得用）" : "青色申告決算書（不動産所得用）";

  return (
    <div className="page">
      <PageHeader title={`決算書（${white ? "収支内訳書・" : ""}不動産所得用）`} note={`${year}年分・${white ? "白色申告" : "青色申告"}`}>
        <div className="seg" role="tablist">
          {tabs.map(([t, label], i) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{i + 1}. {label}</button>
          ))}
        </div>
        <button className="btn ghost" onClick={() => window.print()}><Printer size={16} /> 印刷</button>
      </PageHeader>

      {st.warnings.length > 0 && <p className="notice print-skip">{st.warnings.join("。")}。</p>}
      <section className="sheet statement print-area">
        <header className="statement-head">
          <h2 className={tab === "p1" ? "" : "st-title-small"}>{title}{tab === "p1" ? "" : `　${tabs.findIndex(([t]) => t === tab) + 1}ページ`}</h2>
          <p>
            {settings.business_name || "（屋号未設定）"}　{settings.owner_name}
            <br />
            {tab === "bs" ? `${year}年12月31日 現在` : `自 ${year}年1月1日　至 ${year}年12月31日`}
            {closedHead && <><br /><span className="statement-anchor">確認コード {repo.anchorCode(closedHead)}</span></>}
            {!isYearCompliant(settings, year) && <><br /><span className="statement-off">電子帳簿保存法の対応外（通常の保存）</span></>}
          </p>
        </header>

        {tab === "p1" ? (
          <>
            <ProfitTable st={st} notes={notes} onSaved={set} />
            {white && (
              <div className="st-pages st-page3">
                <section><RentIncomeSection rows={income} notes={notes} onSaved={set} /></section>
                <section>
                  <h3 className="st-h">給料賃金の内訳</h3>
                  <PayTable rows={rows.salaries} prefix="re-salary" withRelation={false} notes={notes} onSaved={set} />
                </section>
              </div>
            )}
          </>
        ) : tab === "p2" && !white ? (
          <div className="st-pages st-page3">
            <section><RentIncomeSection rows={income} notes={notes} onSaved={set} /></section>
            <section>
              <h3 className="st-h">給料賃金の内訳</h3>
              <PayTable rows={rows.salaries} prefix="re-salary" withRelation={false} notes={notes} onSaved={set} />
              <h3 className="st-h">専従者給与の内訳</h3>
              <PayTable rows={rows.family} prefix="re-family" withRelation notes={notes} onSaved={set} />
              {scale !== "business" && rows.family.length > 0 && <p className="field-note">不動産の貸付けが事業的規模でないので、専従者給与は必要経費になりません。</p>}
            </section>
          </div>
        ) : tab === "bs" ? (
          <>
            <BalanceSheetView end={end} opening={opening} />
            <SpecialSection notes={notes} onSaved={set} k="re:special" title="本年中における特殊事情・保証金等の運用状況" />
          </>
        ) : (
          <div className="st-pages st-page3">
            <section><DepreciationSection assets={assets} notes={notes} onSaved={set} rateLabel="貸付割合" /></section>
            <section>
              <InterestSection rows={rows.interest} notes={notes} onSaved={set} prefix="re-interest" title="借入金利子の内訳" />
              {white && <RepairSection rows={rows.repair} notes={notes} onSaved={set} />}
              <RentSection rows={rows.rent} notes={notes} onSaved={set} prefix="re-rent" />
              {white && <HoldingSection notes={notes} onSaved={set} />}
              {(white || hasBusiness) && <SpecialSection notes={notes} onSaved={set} k="re:special" title="本年中における特殊事情・保証金等の運用状況" />}
            </section>
          </div>
        )}
      </section>
    </div>
  );
};
