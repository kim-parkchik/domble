/**
 * 青色申告決算書の2ページ・3ページ
 *  2ページ：月別売上（収入）金額及び仕入金額、給料賃金の内訳、専従者給与の内訳、貸倒引当金繰入額の計算（年末の洗替の仕訳を作る）、青色申告特別控除額の計算
 *  3ページ：売上（収入）金額・仕入金額の明細、減価償却費の計算（固定資産台帳から）、利子割引料・税理士等の報酬・地代家賃の内訳、本年中における特殊事情
 * 明細の表は収支内訳書（WhiteStatementPages.tsx）でも使う
 * 金額は帳簿から出す（lib/statements.ts）。帳簿から出せない項目（年齢・従事月数・住所・賃借物件など）は、
 * その場で書き込んで年度ごとに保存する（statement_notes）
 */
import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import { yen } from "../../lib/format";
import { CODE } from "../../constants/accounts";
import { monthlySales, payeeBreakdown, type PayeeRow } from "../../lib/statements";
import { partnerLines, partnerTable, type PartnerTable } from "../../lib/blueStatement";
import { depreciationFor, isOldStraight, type FixedAsset } from "../../lib/depreciation";
import type { FlatLine } from "../../lib/accounting";
import { ALLOWANCE_NOTE, allowanceAccounts, allowanceCalc, allowanceLines } from "../../lib/allowance";
import type { OpeningBalances } from "../../lib/types";
import * as repo from "../../db/repo";

export type Notes = Record<string, string>;

/** 書き込み欄の数値（カンマ・空白は無視。読めなければ 0） */
const num = (v: string | undefined) => Number((v ?? "").replace(/[,\s円]/g, "")) || 0;

/** 年度の書き込みを読み、保存したら反映する */
export const useNotes = () => {
  const { db, year, dataVersion } = useAppContext();
  const [notes, setNotes] = useState<Notes>({});
  useEffect(() => {
    repo.getStatementNotes(db, year).then(setNotes).catch(console.error);
  }, [db, year, dataVersion]);
  return { notes, set: (k: string, v: string) => setNotes((n) => ({ ...n, [k]: v })) };
};

/** 書き込み欄。離れたときに保存する（印刷では枠を消して文字だけ出す） */
export const Note = ({ k, notes, onSaved, placeholder, align, wide, short }: {
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
export const usePayeeName = () => {
  const { counterparties, subMap } = useAppContext();
  return (r: Pick<PayeeRow, "counterpartyId" | "subId">) =>
    r.counterpartyId ? counterparties.find((c) => c.id === r.counterpartyId)?.name ?? "（取引先）" : r.subId ? subMap.get(r.subId)?.name ?? "（補助科目）" : "（支払先の指定なし）";
};

/** 家事按分の年末の振替・減価償却の仕訳（支払先の内訳には数えない） */
export const useRunIds = () => {
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

/** 支払先ごとの内訳（給料賃金・専従者給与・利子割引料・地代家賃・支払手数料）。家事按分の年末の振替・減価償却の仕訳は数えない */
export const useDetailRows = (lines: FlatLine[]) => {
  const { accounts, homeUseRates } = useAppContext();
  const runIds = useRunIds();
  const drawId = accountIdOf(accounts, CODE.OWNER_DRAW);
  const breakdown = (code: string, yearEnd: boolean) => {
    const id = accountIdOf(accounts, code);
    const rate = yearEnd ? homeUseRates.find((r) => r.account_id === id && r.method === "yearend") : undefined;
    return payeeBreakdown(id, lines, { drawId, yearEndRate: rate?.rate ?? null, excludeEntryIds: runIds });
  };
  return {
    salaries: breakdown(CODE.SALARIES, false), family: breakdown(CODE.FAMILY_SALARY, false),
    interest: breakdown(CODE.INTEREST, true), rent: breakdown(CODE.RENT, true), fees: breakdown(CODE.FEES, true),
  };
};

/** 固定資産台帳（減価償却費の計算に使う） */
export const useAssets = () => {
  const { db, dataVersion } = useAppContext();
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  useEffect(() => {
    repo.getAssets(db).then(setAssets).catch(console.error);
  }, [db, dataVersion]);
  return assets;
};

type NoteProps = { notes: Notes; onSaved: (k: string, v: string) => void };

/** 給料賃金・専従者給与の内訳（氏名は支払先、年齢・従事月数・賞与・源泉徴収税額は書き込み） */
export const PayTable = ({ rows, prefix, withRelation, notes, onSaved }: NoteProps & { rows: PayeeRow[]; prefix: string; withRelation: boolean }) => {
  const payeeName = usePayeeName();
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
            {withRelation && <td><Note k={`${prefix}:${r.key}:relation`} notes={notes} onSaved={onSaved} placeholder="続柄" short /></td>}
            <td><Note k={`${prefix}:${r.key}:age`} notes={notes} onSaved={onSaved} placeholder="年齢" align="right" short /></td>
            <td><Note k={`${prefix}:${r.key}:months`} notes={notes} onSaved={onSaved} placeholder="月数" align="right" short /></td>
            <td className="num">{yen(r.gross - bonus(r))}</td>
            <td><Note k={`${prefix}:${r.key}:bonus`} notes={notes} onSaved={onSaved} placeholder="賞与" align="right" /></td>
            <td className="num">{yen(r.gross)}</td>
            <td><Note k={`${prefix}:${r.key}:tax`} notes={notes} onSaved={onSaved} placeholder="源泉" align="right" /></td>
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

// ────────────────────────────────────────────
// 2ページ
// ────────────────────────────────────────────
export const StatementPage2 = ({ lines, income, deductionLimit, end, opening }: {
  lines: FlatLine[]; income: number; deductionLimit: number; end: Map<number, number>; opening: OpeningBalances;
}) => {
  const { accounts } = useAppContext();
  const { notes, set } = useNotes();
  const { salaries, family } = useDetailRows(lines);
  const m = monthlySales(accounts, lines);
  const salesTotal = m.sales.reduce((s, x) => s + x, 0) + m.householdUse + m.miscIncome;
  const purchaseTotal = m.purchases.reduce((s, x) => s + x, 0);
  const deduction = Math.min(deductionLimit, Math.max(0, income));

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
        <PayTable rows={salaries} prefix="salary" withRelation={false} notes={notes} onSaved={set} />
        <h3 className="st-h">専従者給与の内訳</h3>
        <PayTable rows={family} prefix="family" withRelation notes={notes} onSaved={set} />
        <p className="field-note screen-only">
          氏名は、仕訳の取引先か補助科目から出します（人ごとに補助科目を作っておくと分かれます）。賞与を入れると、合計のうち残りを給料にします。
          専従者の続柄と従事月数は、確定申告書の第二表「事業専従者に関する事項」にも書きます。
        </p>

        <AllowanceSection end={end} opening={opening} notes={notes} onSaved={set} />

        <h3 className="st-h">青色申告特別控除額の計算</h3>
        <table className="ledger st-detail">
          <tbody>
            <tr><td>青色申告特別控除前の所得金額</td><td className="num">{yen(income)}</td></tr>
            <tr><td>青色申告特別控除額の上限</td><td className="num">{yen(deductionLimit)}</td></tr>
            <tr className="st-strong"><td>青色申告特別控除額（目安）</td><td className="num">{yen(deduction)}</td></tr>
          </tbody>
        </table>
        <p className="field-note">不動産所得がある場合などは、控除額の配分が変わります（ここでは事業所得だけで計算した目安です）。</p>
      </section>
    </div>
  );
};

/**
 * 貸倒引当金繰入額の計算（① 個別評価・② 貸金・③ 繰入限度額・④ 一括評価の繰入額・⑤ 計）と、年末の洗替の仕訳
 * ①・②の調整・④・金融業は書き込みに持つ（lib/allowance.ts）。印刷では表だけ出す
 */
const AllowanceSection = ({ end, opening, notes, onSaved }: NoteProps & { end: Map<number, number>; opening: OpeningBalances }) => {
  const { db, year, accounts, dataVersion, bump, isClosed, can, readOnly } = useAppContext();
  const toast = useToast();
  const accs = allowanceAccounts(accounts);
  const calc = allowanceCalc(accounts, (a) => end.get(a.id) ?? 0, accs.allowance ? opening[accs.allowance.id] ?? 0 : 0, notes, true);
  const [runId, setRunId] = useState<number | null>(null);
  useEffect(() => {
    repo.getAllowanceRun(db, year).then(setRunId).catch(console.error);
  }, [db, year, dataVersion]);
  const booked = (id: number | undefined) => (id ? end.get(id) ?? 0 : 0);
  const matches = booked(accs.add?.id) === calc.total && booked(accs.back?.id) === calc.reversal;
  const disabled = isClosed || readOnly || !can("entry");
  const toggleFinance = async (on: boolean) => {
    try {
      await repo.saveStatementNote(db, year, ALLOWANCE_NOTE.finance, on ? "1" : "");
      onSaved(ALLOWANCE_NOTE.finance, on ? "1" : "");
    } catch (e) {
      toast(`保存できませんでした：${String(e).replace(/^Error: /, "")}`, "error");
    }
  };
  const run = async () => {
    const lines = allowanceLines(accounts, calc);
    if (!lines) return toast("貸倒引当金・貸倒引当金繰入・貸倒引当金戻入の科目が見つかりません（勘定科目の画面で確かめてください）", "error");
    const ok = await ask(
      lines.length === 0
        ? `${year}年は戻し入れも繰り入れも無いので、作成済みの貸倒引当金の仕訳を削除します。`
        : `${year}年12月31日付で、前年分の戻入 ${yen(calc.reversal)} 円と本年分の繰入 ${yen(calc.total)} 円の決算整理仕訳を${runId ? "作り直します" : "作ります"}。`,
      { title: "貸倒引当金の仕訳", okLabel: runId ? "作り直す" : "作成する", cancelLabel: "やめる" },
    );
    if (!ok) return;
    try {
      await repo.saveAllowanceRun(db, year, lines);
      bump();
      toast(lines.length === 0 ? "貸倒引当金の仕訳を削除しました" : "貸倒引当金の仕訳を作成しました");
    } catch (e) {
      toast(`作成できませんでした：${String(e).replace(/^Error: /, "")}`, "error");
    }
  };
  return (
    <>
      <h3 className="st-h">貸倒引当金繰入額の計算</h3>
      <table className="ledger st-detail st-allowance">
        <tbody>
          <tr><td>① 個別評価による本年分繰入額</td><td className="num"><Note k={ALLOWANCE_NOTE.individual} notes={notes} onSaved={onSaved} align="right" placeholder="0" /></td></tr>
          <tr><td>② 年末における一括評価による貸倒引当金の繰入れの対象となる貸金の合計額</td><td className="num">{yen(calc.base)}</td></tr>
          <tr className="screen-only">
            <td className="indent muted">
              {calc.receivables.map((r) => `${r.name} ${yen(r.amount)}`).join("・")}（年末の残高）に足し引きする額
            </td>
            <td className="num"><Note k={ALLOWANCE_NOTE.adjust} notes={notes} onSaved={onSaved} align="right" placeholder="0" /></td>
          </tr>
          <tr>
            <td>
              ③ 本年分繰入限度額（②×{calc.finance ? "3.3" : "5.5"}%）
              <label className="check screen-only st-inline-check">
                <input type="checkbox" checked={calc.finance} disabled={disabled} onChange={(e) => toggleFinance(e.target.checked)} /> 金融業
              </label>
            </td>
            <td className="num">{yen(calc.limit)}</td>
          </tr>
          <tr>
            <td>④ 本年分繰入額<span className="muted screen-only">（空なら繰入限度額）</span></td>
            <td className="num">
              <span className="screen-only"><Note k={ALLOWANCE_NOTE.amount} notes={notes} onSaved={onSaved} align="right" placeholder={yen(calc.limit)} /></span>
              <span className="print-only">{yen(calc.bulk)}</span>
            </td>
          </tr>
          <tr className="st-strong"><td>⑤ 本年分の貸倒引当金繰入額（①＋④）</td><td className="num">{yen(calc.total)}</td></tr>
        </tbody>
      </table>
      {calc.problems.map((p) => <p key={p} className="notice screen-only">{p}。</p>)}
      <div className="st-allowance-run screen-only">
        <span>前年からの繰戻し（期首の貸倒引当金）{yen(calc.reversal)} 円。</span>
        {runId
          ? <span className={matches ? "muted" : "balance-ng"}>{matches ? "仕訳は作成済みです。" : "帳簿の繰入・戻入がこの計算と違います。作り直してください。"}</span>
          : (calc.total > 0 || calc.reversal > 0) && <span className={matches ? "muted" : "balance-ng"}>{matches ? "帳簿の繰入・戻入はこの計算と同じです。" : "年末の仕訳はまだです。"}</span>}
        <button type="button" className="btn ghost sm" onClick={run} disabled={disabled || (!runId && calc.total === 0 && calc.reversal === 0)}>
          {runId ? "仕訳を作り直す" : "仕訳を作る"}
        </button>
      </div>
      <p className="field-note screen-only">
        青色申告の人は、年末の売掛金・受取手形・貸付金・未収入金などの貸金の5.5%（金融業は3.3%）まで貸倒引当金に繰り入れられます。
        家事上の貸金、保証金・敷金、手付金・前渡金、仮払金・立替金、同じ相手の買掛金と相殺できる額、個別評価の相手の分などは対象にならないので「足し引きする額」で引き、
        割り引いたり裏書譲渡したりした受取手形は足します。前年に繰り入れた額は、本年に戻し入れて収入にします（洗替）。
        仕訳は12月31日付の決算整理仕訳で「貸倒引当金 / 貸倒引当金戻入」「貸倒引当金繰入 / 貸倒引当金」です。
      </p>
    </>
  );
};

// ────────────────────────────────────────────
// 3ページ（明細の表は収支内訳書でも使う）
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
const included = (notes: Notes, k: string, defaultOn: boolean) => (notes[k] ? notes[k] === "1" : defaultOn);

/** 売上先・仕入先の明細の表（様式は4行と「上記以外」） */
export const PartnerSection = ({ kind, table, otherLabel, notes, onSaved }: NoteProps & { kind: "sales" | "purchase"; table: PartnerTable; otherLabel: string }) => (
  <>
    <h3 className="st-h">{kind === "sales" ? "売上（収入）金額の明細" : "仕入金額の明細"}</h3>
    {table.total === 0 && table.rows.length === 0 ? <p className="muted">該当する取引はありません。</p> : (
      <table className="ledger st-detail">
        <thead>
          <tr><th>{kind === "sales" ? "売上先名" : "仕入先名"}</th><th>所在地</th><th>登録番号</th><th className="num">{kind === "sales" ? "売上（収入）金額" : "仕入金額"}</th></tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr key={r.key}>
              <td>{r.name}</td>
              <td><Note k={`${kind}:${r.key}:address`} notes={notes} onSaved={onSaved} placeholder={r.invoiceNo ? "（登録番号があれば省略可）" : "所在地"} wide /></td>
              <td>{r.invoiceNo ? `T${r.invoiceNo}` : ""}</td>
              <td className="num">{yen(r.amount)}</td>
            </tr>
          ))}
          <tr><td colSpan={3}>{otherLabel}</td><td className="num">{yen(table.other, { blankZero: true })}</td></tr>
        </tbody>
        <tfoot><tr><td colSpan={3}>計</td><td className="num">{yen(table.total)}</td></tr></tfoot>
      </table>
    )}
  </>
);

/** 売上先・仕入先の明細（両方の表と説明） */
export const PartnerSections = ({ lines, salesTotal, purchaseTotal, salesOther, notes, onSaved }: NoteProps & {
  lines: FlatLine[]; salesTotal: number; purchaseTotal: number; salesOther: string;
}) => {
  const { accounts, counterparties } = useAppContext();
  const payeeName = usePayeeName();
  const invoiceNoOf = (id: number) => counterparties.find((c) => c.id === id)?.invoice_no ?? "";
  const sales = partnerTable(partnerLines("sales", accounts, lines, notes, payeeName, invoiceNoOf), salesTotal);
  const purchases = partnerTable(partnerLines("purchase", accounts, lines, notes, payeeName, invoiceNoOf), purchaseTotal);
  return (
    <>
      <PartnerSection kind="sales" table={sales} otherLabel={salesOther} notes={notes} onSaved={onSaved} />
      <PartnerSection kind="purchase" table={purchases} otherLabel="上記以外の仕入先の計" notes={notes} onSaved={onSaved} />
      <p className="field-note screen-only">
        売上先・仕入先は、仕訳の取引先（無ければ補助科目）ごとに、金額の多い順に4件まで出します。取引先も補助科目も無い取引は「上記以外」に入ります。
        登録番号は取引先の画面のもので、登録番号を書いた相手は名前と所在地を省略できます。
      </p>
    </>
  );
};

const METHOD_SHORT: Record<FixedAsset["method"], string> = { straight: "定額法", lump3: "一括償却", small: "少額" };

export const DepreciationSection = ({ assets, notes, onSaved }: NoteProps & { assets: FixedAsset[] }) => {
  const { year } = useAppContext();
  const deps = assets
    .map((a) => ({ a, d: depreciationFor(a, year) }))
    .filter((x) => x.d && !(x.d.opening === 0 && x.d.depreciation === 0));
  const depSum = (k: "depreciation" | "business" | "closing") => deps.reduce((s, x) => s + x.d![k], 0);
  return (
    <>
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
                  <td><Note k={`dep:${a.id}:qty`} notes={notes} onSaved={onSaved} placeholder="数量" /></td>
                  <td>{a.acquired_on.slice(0, 4)}年{Number(a.acquired_on.slice(5, 7))}月</td>
                  <td className="num">{yen(a.cost)}</td>
                  <td className="num">{yen(d!.base)}</td>
                  <td>{isOldStraight(a) ? "旧定額法" : METHOD_SHORT[a.method]}</td>
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
                    {[a.method === "small" ? "措法28の2" : "", d!.equal ? "均等償却" : "", d!.disposed ? `${a.disposed_on!.slice(5, 7).replace(/^0/, "")}月売却・除却` : "", a.memo].filter(Boolean).join("　")}
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
    </>
  );
};

export const InterestSection = ({ rows, notes, onSaved }: NoteProps & { rows: PayeeRow[] }) => {
  const payeeName = usePayeeName();
  return (
    <>
      <h3 className="st-h">利子割引料の内訳（金融機関を除く）</h3>
      {rows.length === 0 ? <p className="muted">該当する支払いはありません。</p> : (
        <table className="ledger st-detail">
          <thead><tr><th className="screen-only">書く</th><th>支払先の住所・氏名</th><th className="num">期末現在の借入金等の金額</th><th className="num">本年中の利子割引料</th><th className="num">左のうち必要経費算入額</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={included(notes, `interest:${r.key}:use`, true) ? "" : "print-skip"}>
                <td className="screen-only"><Include k={`interest:${r.key}:use`} defaultOn notes={notes} onSaved={onSaved} /></td>
                <td>{payeeName(r)}<Note k={`interest:${r.key}:address`} notes={notes} onSaved={onSaved} placeholder="住所" wide /></td>
                <td><Note k={`interest:${r.key}:loan`} notes={notes} onSaved={onSaved} placeholder="借入金の残高" align="right" /></td>
                <td className="num">{yen(r.gross)}</td>
                <td className="num">{yen(r.business)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="field-note screen-only">金融機関（銀行など）への利子は決算書に書かないので、「書く」のチェックを外してください（印刷に出ません）。</p>
    </>
  );
};

export const FeesSection = ({ rows, notes, onSaved }: NoteProps & { rows: PayeeRow[] }) => {
  const payeeName = usePayeeName();
  return (
    <>
      <h3 className="st-h">税理士・弁護士等の報酬・料金の内訳</h3>
      {rows.length === 0 ? <p className="muted">支払手数料の支払いはありません。</p> : (
        <table className="ledger st-detail">
          <thead><tr><th className="screen-only">書く</th><th>支払先の住所・氏名</th><th className="num">本年中の報酬等の金額</th><th className="num">左のうち必要経費算入額</th><th className="num">源泉徴収税額</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={included(notes, `fees:${r.key}:use`, false) ? "" : "print-skip"}>
                <td className="screen-only"><Include k={`fees:${r.key}:use`} defaultOn={false} notes={notes} onSaved={onSaved} /></td>
                <td>{payeeName(r)}<Note k={`fees:${r.key}:address`} notes={notes} onSaved={onSaved} placeholder="住所" wide /></td>
                <td className="num">{yen(r.gross)}</td>
                <td className="num">{yen(r.business)}</td>
                <td><Note k={`fees:${r.key}:tax`} notes={notes} onSaved={onSaved} placeholder="源泉" align="right" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="field-note screen-only">支払手数料の支払先のうち、税理士・弁護士などへの報酬だけ「書く」にチェックを入れてください。</p>
    </>
  );
};

export const RentSection = ({ rows, notes, onSaved }: NoteProps & { rows: PayeeRow[] }) => {
  const payeeName = usePayeeName();
  return (
    <>
      <h3 className="st-h">地代家賃の内訳</h3>
      {rows.length === 0 ? <p className="muted">該当する支払いはありません。</p> : (
        <table className="ledger st-detail">
          <thead><tr><th>支払先の住所・氏名</th><th>賃借物件</th><th className="num">権利金・更新料等</th><th className="num">本年中の賃借料</th><th className="num">左の賃借料のうち必要経費算入額</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{payeeName(r)}<Note k={`rent:${r.key}:address`} notes={notes} onSaved={onSaved} placeholder="住所" wide /></td>
                <td><Note k={`rent:${r.key}:property`} notes={notes} onSaved={onSaved} placeholder="例：事務所" /></td>
                <td><Note k={`rent:${r.key}:key`} notes={notes} onSaved={onSaved} placeholder="権利金等" align="right" /></td>
                <td className="num">{yen(r.gross)}</td>
                <td className="num">{yen(r.business)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="field-note screen-only">家事按分している場合、必要経費算入額は事業分だけになります。</p>
    </>
  );
};

export const SpecialSection = ({ notes, onSaved }: NoteProps) => (
  <>
    <h3 className="st-h">本年中における特殊事情</h3>
    <Note k="special" notes={notes} onSaved={onSaved} placeholder="例：4月に開業、10月に事務所を移転 など" wide />
  </>
);

export const StatementPage3 = ({ lines, salesTotal, purchaseTotal }: { lines: FlatLine[]; salesTotal: number; purchaseTotal: number }) => {
  const { notes, set } = useNotes();
  const { interest, rent, fees } = useDetailRows(lines);
  const assets = useAssets();
  return (
    <div className="st-pages st-page3">
      <section>
        <PartnerSections lines={lines} salesTotal={salesTotal} purchaseTotal={purchaseTotal} salesOther="上記以外の売上先の計（雑収入を含む）" notes={notes} onSaved={set} />
      </section>
      <section>
        <DepreciationSection assets={assets} notes={notes} onSaved={set} />
      </section>
      <section>
        <InterestSection rows={interest} notes={notes} onSaved={set} />
        <FeesSection rows={fees} notes={notes} onSaved={set} />
        <RentSection rows={rent} notes={notes} onSaved={set} />
        <SpecialSection notes={notes} onSaved={set} />
      </section>
    </div>
  );
};
