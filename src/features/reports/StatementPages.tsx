/**
 * 青色申告決算書の2ページ・3ページ
 *  2ページ：月別売上（収入）金額及び仕入金額、給料賃金の内訳、専従者給与の内訳、青色申告特別控除額の計算
 *  3ページ：減価償却費の計算（固定資産台帳から）、利子割引料・税理士等の報酬・地代家賃の内訳、本年中における特殊事情
 * 金額は帳簿から出す（lib/statements.ts）。帳簿から出せない項目（年齢・従事月数・住所・賃借物件など）は、
 * その場で書き込んで年度ごとに保存する（statement_notes）
 */
import { useEffect, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import { yen } from "../../lib/format";
import { CODE } from "../../constants/accounts";
import { monthlySales, payeeBreakdown, type PayeeRow } from "../../lib/statements";
import { depreciationFor, type FixedAsset } from "../../lib/depreciation";
import type { FlatLine } from "../../lib/accounting";
import * as repo from "../../db/repo";

type Notes = Record<string, string>;

/** 書き込み欄の数値（カンマ・空白は無視。読めなければ 0） */
const num = (v: string | undefined) => Number((v ?? "").replace(/[,\s円]/g, "")) || 0;

/** 年度の書き込みを読み、保存したら反映する */
const useNotes = () => {
  const { db, year, dataVersion } = useAppContext();
  const [notes, setNotes] = useState<Notes>({});
  useEffect(() => {
    repo.getStatementNotes(db, year).then(setNotes).catch(console.error);
  }, [db, year, dataVersion]);
  return { notes, set: (k: string, v: string) => setNotes((n) => ({ ...n, [k]: v })) };
};

/** 書き込み欄。離れたときに保存する（印刷では枠を消して文字だけ出す） */
const Note = ({ k, notes, onSaved, placeholder, align, wide, short }: {
  k: string; notes: Notes; onSaved: (k: string, v: string) => void; placeholder?: string; align?: "right"; wide?: boolean; short?: boolean;
}) => {
  const { db, year, isClosed, can, readOnly } = useAppContext();
  const toast = useToast();
  const saved = notes[k] ?? "";
  const [v, setV] = useState(saved);
  useEffect(() => setV(saved), [saved]);
  return (
    <input
      className={`note-input${align === "right" ? " num" : ""}${wide ? " wide" : ""}${short ? " short" : ""}`}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={async () => {
        if (v.trim() === saved) return;
        try {
          await repo.saveStatementNote(db, year, k, v);
          onSaved(k, v.trim());
        } catch (e) {
          toast(`保存できませんでした：${String(e).replace(/^Error: /, "")}`, "error");
          setV(saved);
        }
      }}
      placeholder={placeholder}
      disabled={isClosed || readOnly || !can("master")}
      aria-label={placeholder}
    />
  );
};

/** 支払先の名前（取引先 → 補助科目 → 指定なし） */
const usePayeeName = () => {
  const { counterparties, subMap } = useAppContext();
  return (r: PayeeRow) =>
    r.counterpartyId ? counterparties.find((c) => c.id === r.counterpartyId)?.name ?? "（取引先）" : r.subId ? subMap.get(r.subId)?.name ?? "（補助科目）" : "（支払先の指定なし）";
};

/** 家事按分の年末の振替・減価償却の仕訳（支払先の内訳には数えない） */
const useRunIds = () => {
  const { db, year, dataVersion } = useAppContext();
  const [ids, setIds] = useState<number[]>([]);
  useEffect(() => {
    Promise.all([repo.getHomeUseRun(db, year), repo.getDepreciationRun(db, year)])
      .then((r) => setIds(r.filter((x): x is number => x !== null)))
      .catch(console.error);
  }, [db, year, dataVersion]);
  return ids;
};

const accountIdOf = (accounts: { id: number; code: string }[], code: string) => accounts.find((a) => a.code === code)?.id ?? 0;

// ────────────────────────────────────────────
// 2ページ
// ────────────────────────────────────────────
export const StatementPage2 = ({ lines, income, deductionLimit }: { lines: FlatLine[]; income: number; deductionLimit: number }) => {
  const { accounts, settings } = useAppContext();
  const { notes, set } = useNotes();
  const payeeName = usePayeeName();
  const runIds = useRunIds();
  const m = monthlySales(accounts, lines);
  const salesTotal = m.sales.reduce((s, x) => s + x, 0) + m.householdUse + m.miscIncome;
  const purchaseTotal = m.purchases.reduce((s, x) => s + x, 0);
  const drawId = accountIdOf(accounts, CODE.OWNER_DRAW);
  const salaries = payeeBreakdown(accountIdOf(accounts, CODE.SALARIES), lines, { drawId, excludeEntryIds: runIds });
  const family = payeeBreakdown(accountIdOf(accounts, CODE.FAMILY_SALARY), lines, { drawId, excludeEntryIds: runIds });
  const deduction = Math.min(deductionLimit, Math.max(0, income));

  const payTable = (rows: PayeeRow[], prefix: string, withRelation: boolean) => {
    const bonus = (r: PayeeRow) => num(notes[`${prefix}:${r.key}:bonus`]);
    const tax = rows.reduce((s, r) => s + num(notes[`${prefix}:${r.key}:tax`]), 0);
    return rows.length === 0 ? (
      <p className="muted">該当する支払いはありません。</p>
    ) : (
      <table className="ledger st-detail">
        <thead>
          <tr>
            <th>氏名</th>{withRelation && <th>続柄</th>}<th className="num">年齢</th><th className="num">従事月数</th>
            <th className="num">{withRelation ? "給料" : "給料賃金"}</th><th className="num">賞与</th><th className="num">合計</th><th className="num">源泉徴収税額</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{payeeName(r)}</td>
              {withRelation && <td><Note k={`${prefix}:${r.key}:relation`} notes={notes} onSaved={set} placeholder="続柄" short /></td>}
              <td><Note k={`${prefix}:${r.key}:age`} notes={notes} onSaved={set} placeholder="年齢" align="right" short /></td>
              <td><Note k={`${prefix}:${r.key}:months`} notes={notes} onSaved={set} placeholder="月数" align="right" short /></td>
              <td className="num">{yen(r.gross - bonus(r))}</td>
              <td><Note k={`${prefix}:${r.key}:bonus`} notes={notes} onSaved={set} placeholder="賞与" align="right" /></td>
              <td className="num">{yen(r.gross)}</td>
              <td><Note k={`${prefix}:${r.key}:tax`} notes={notes} onSaved={set} placeholder="源泉" align="right" /></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={withRelation ? 4 : 3}>計</td>
            <td className="num">{yen(rows.reduce((s, r) => s + r.gross - bonus(r), 0))}</td>
            <td className="num">{yen(rows.reduce((s, r) => s + bonus(r), 0))}</td>
            <td className="num">{yen(rows.reduce((s, r) => s + r.gross, 0))}</td>
            <td className="num">{yen(tax)}</td>
          </tr>
        </tfoot>
      </table>
    );
  };

  return (
    <div className="st-pages">
      <section>
        <h3 className="st-h">月別売上（収入）金額及び仕入金額</h3>
        <table className="ledger st-detail st-monthly">
          <thead><tr><th>月</th><th className="num">売上（収入）金額</th><th className="num">仕入金額</th></tr></thead>
          <tbody>
            {m.sales.map((s, i) => (
              <tr key={i}><td>{i + 1}月</td><td className="num">{yen(s, { blankZero: true })}</td><td className="num">{yen(m.purchases[i], { blankZero: true })}</td></tr>
            ))}
            <tr><td>家事消費等</td><td className="num">{yen(m.householdUse, { blankZero: true })}</td><td /></tr>
            <tr><td>雑収入</td><td className="num">{yen(m.miscIncome, { blankZero: true })}</td><td /></tr>
          </tbody>
          <tfoot><tr><td>計</td><td className="num">{yen(salesTotal)}</td><td className="num">{yen(purchaseTotal)}</td></tr></tfoot>
        </table>
      </section>

      <section>
        <h3 className="st-h">給料賃金の内訳</h3>
        {payTable(salaries, "salary", false)}
        <h3 className="st-h">専従者給与の内訳</h3>
        {payTable(family, "family", true)}
        <p className="field-note screen-only">
          氏名は、仕訳の取引先か補助科目から出します（人ごとに補助科目を作っておくと分かれます）。賞与を入れると、合計のうち残りを給料にします。
        </p>

        <h3 className="st-h">青色申告特別控除額の計算</h3>
        <table className="ledger st-detail">
          <tbody>
            <tr><td>青色申告特別控除前の所得金額</td><td className="num">{yen(income)}</td></tr>
            <tr><td>青色申告特別控除額の上限</td><td className="num">{yen(deductionLimit)}</td></tr>
            <tr className="st-strong"><td>青色申告特別控除額（目安）</td><td className="num">{yen(deduction)}</td></tr>
          </tbody>
        </table>
        <p className="field-note">
          {settings.filing_type === "white" ? "白色申告では青色申告特別控除はありません。" : "不動産所得がある場合などは、控除額の配分が変わります（ここでは事業所得だけで計算した目安です）。"}
        </p>
      </section>
    </div>
  );
};

// ────────────────────────────────────────────
// 3ページ
// ────────────────────────────────────────────
/** 決算書に書くかどうか（利子は金融機関の分を除く、報酬は支払手数料のうち税理士・弁護士等の分だけ）。既定と同じなら保存しない */
const Include = ({ k, defaultOn, notes, onSaved }: { k: string; defaultOn: boolean; notes: Notes; onSaved: (k: string, v: string) => void }) => {
  const { db, year, isClosed, can, readOnly } = useAppContext();
  const toast = useToast();
  const on = notes[k] ? notes[k] === "1" : defaultOn;
  return (
    <input
      type="checkbox"
      checked={on}
      disabled={isClosed || readOnly || !can("master")}
      onChange={async (e) => {
        const v = e.target.checked === defaultOn ? "" : e.target.checked ? "1" : "0";
        try {
          await repo.saveStatementNote(db, year, k, v);
          onSaved(k, v);
        } catch (err) {
          toast(`保存できませんでした：${String(err).replace(/^Error: /, "")}`, "error");
        }
      }}
      aria-label="決算書に書く"
    />
  );
};

const METHOD_SHORT: Record<FixedAsset["method"], string> = { straight: "定額法", lump3: "一括償却", small: "少額" };

export const StatementPage3 = ({ lines }: { lines: FlatLine[] }) => {
  const { db, year, accounts, homeUseRates, dataVersion } = useAppContext();
  const { notes, set } = useNotes();
  const payeeName = usePayeeName();
  const runIds = useRunIds();
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  useEffect(() => {
    repo.getAssets(db).then(setAssets).catch(console.error);
  }, [db, dataVersion]);

  const drawId = accountIdOf(accounts, CODE.OWNER_DRAW);
  const breakdown = (code: string) => {
    const id = accountIdOf(accounts, code);
    const rate = homeUseRates.find((r) => r.account_id === id && r.method === "yearend");
    return payeeBreakdown(id, lines, { drawId, yearEndRate: rate?.rate ?? null, excludeEntryIds: runIds });
  };
  const interest = breakdown(CODE.INTEREST);
  const rent = breakdown(CODE.RENT);
  const fees = breakdown(CODE.FEES);

  const deps = assets
    .map((a) => ({ a, d: depreciationFor(a, year) }))
    .filter((x) => x.d && !(x.d.opening === 0 && x.d.depreciation === 0));
  const depSum = (k: "depreciation" | "business" | "closing") => deps.reduce((s, x) => s + x.d![k], 0);

  const included = (k: string, defaultOn: boolean) => (notes[k] ? notes[k] === "1" : defaultOn);

  return (
    <div className="st-pages st-page3">
      <section>
        <h3 className="st-h">減価償却費の計算</h3>
        {deps.length === 0 ? (
          <p className="muted">{year}年に償却する資産はありません（固定資産台帳に登録すると、ここに出ます）。</p>
        ) : (
          <div className="table-wrap">
            <table className="ledger st-detail st-dep">
              <thead>
                <tr>
                  <th>減価償却資産の名称等</th><th>面積又は数量</th><th>取得年月</th><th className="num">取得価額</th><th className="num">償却の基礎になる金額</th>
                  <th>償却方法</th><th className="num">耐用年数</th><th className="num">償却率</th><th className="num">本年中の償却期間</th>
                  <th className="num">本年分の普通償却費</th><th className="num">特別償却費</th><th className="num">本年分の償却費合計</th>
                  <th className="num">事業専用割合</th><th className="num">本年分の必要経費算入額</th><th className="num">未償却残高（期末残高）</th><th>摘要</th>
                </tr>
              </thead>
              <tbody>
                {deps.map(({ a, d }) => (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td><Note k={`dep:${a.id}:qty`} notes={notes} onSaved={set} placeholder="数量" /></td>
                    <td>{a.acquired_on.slice(0, 4)}年{Number(a.acquired_on.slice(5, 7))}月</td>
                    <td className="num">{yen(a.cost)}</td>
                    <td className="num">{yen(a.cost)}</td>
                    <td>{METHOD_SHORT[a.method]}</td>
                    <td className="num">{a.method === "straight" ? `${a.useful_life}年` : a.method === "lump3" ? "3年" : "—"}</td>
                    <td className="num">{d!.rate !== null ? d!.rate.toFixed(3) : a.method === "lump3" ? "1/3" : "—"}</td>
                    <td className="num">{d!.months}/12</td>
                    <td className="num">{yen(d!.depreciation)}</td>
                    <td className="num">—</td>
                    <td className="num">{yen(d!.depreciation)}</td>
                    <td className="num">{a.business_rate}%</td>
                    <td className="num">{yen(d!.business)}</td>
                    <td className="num">{yen(d!.closing)}</td>
                    <td>
                      {[a.method === "small" ? "措法28の2" : "", d!.disposed ? `${a.disposed_on!.slice(5, 7).replace(/^0/, "")}月売却・除却` : "", a.memo].filter(Boolean).join("　")}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={9}>計</td>
                  <td className="num">{yen(depSum("depreciation"))}</td><td className="num" /><td className="num">{yen(depSum("depreciation"))}</td>
                  <td /><td className="num">{yen(depSum("business"))}</td><td className="num">{yen(depSum("closing"))}</td><td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 className="st-h">利子割引料の内訳（金融機関を除く）</h3>
        {interest.length === 0 ? <p className="muted">該当する支払いはありません。</p> : (
          <table className="ledger st-detail">
            <thead><tr><th className="screen-only">書く</th><th>支払先の住所・氏名</th><th className="num">期末現在の借入金等の金額</th><th className="num">本年中の利子割引料</th><th className="num">左のうち必要経費算入額</th></tr></thead>
            <tbody>
              {interest.map((r) => (
                <tr key={r.key} className={included(`interest:${r.key}:use`, true) ? "" : "print-skip"}>
                  <td className="screen-only"><Include k={`interest:${r.key}:use`} defaultOn notes={notes} onSaved={set} /></td>
                  <td>{payeeName(r)}<Note k={`interest:${r.key}:address`} notes={notes} onSaved={set} placeholder="住所" wide /></td>
                  <td><Note k={`interest:${r.key}:loan`} notes={notes} onSaved={set} placeholder="借入金の残高" align="right" /></td>
                  <td className="num">{yen(r.gross)}</td>
                  <td className="num">{yen(r.business)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="field-note screen-only">金融機関（銀行など）への利子は決算書に書かないので、「書く」のチェックを外してください（印刷に出ません）。</p>

        <h3 className="st-h">税理士・弁護士等の報酬・料金の内訳</h3>
        {fees.length === 0 ? <p className="muted">支払手数料の支払いはありません。</p> : (
          <table className="ledger st-detail">
            <thead><tr><th className="screen-only">書く</th><th>支払先の住所・氏名</th><th className="num">本年中の報酬等の金額</th><th className="num">左のうち必要経費算入額</th><th className="num">源泉徴収税額</th></tr></thead>
            <tbody>
              {fees.map((r) => (
                <tr key={r.key} className={included(`fees:${r.key}:use`, false) ? "" : "print-skip"}>
                  <td className="screen-only"><Include k={`fees:${r.key}:use`} defaultOn={false} notes={notes} onSaved={set} /></td>
                  <td>{payeeName(r)}<Note k={`fees:${r.key}:address`} notes={notes} onSaved={set} placeholder="住所" wide /></td>
                  <td className="num">{yen(r.gross)}</td>
                  <td className="num">{yen(r.business)}</td>
                  <td><Note k={`fees:${r.key}:tax`} notes={notes} onSaved={set} placeholder="源泉" align="right" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="field-note screen-only">支払手数料の支払先のうち、税理士・弁護士などへの報酬だけ「書く」にチェックを入れてください。</p>

        <h3 className="st-h">地代家賃の内訳</h3>
        {rent.length === 0 ? <p className="muted">該当する支払いはありません。</p> : (
          <table className="ledger st-detail">
            <thead><tr><th>支払先の住所・氏名</th><th>賃借物件</th><th className="num">権利金・更新料等</th><th className="num">本年中の賃借料</th><th className="num">左の賃借料のうち必要経費算入額</th></tr></thead>
            <tbody>
              {rent.map((r) => (
                <tr key={r.key}>
                  <td>{payeeName(r)}<Note k={`rent:${r.key}:address`} notes={notes} onSaved={set} placeholder="住所" wide /></td>
                  <td><Note k={`rent:${r.key}:property`} notes={notes} onSaved={set} placeholder="例：事務所" /></td>
                  <td><Note k={`rent:${r.key}:key`} notes={notes} onSaved={set} placeholder="権利金等" align="right" /></td>
                  <td className="num">{yen(r.gross)}</td>
                  <td className="num">{yen(r.business)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="field-note screen-only">家事按分している場合、必要経費算入額は事業分だけになります。</p>

        <h3 className="st-h">本年中における特殊事情</h3>
        <Note k="special" notes={notes} onSaved={set} placeholder="例：4月に開業、10月に事務所を移転 など" wide />
      </section>
    </div>
  );
};
