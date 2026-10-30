/**
 * 所得税：確定申告書（第一表・第二表）の数字（計算は lib/incomeTax.ts）
 *  - 入力：帳簿から出せないもの（給与・公的年金等・雑所得、源泉徴収、所得控除、配偶者・扶養親族、住宅借入金等特別控除、予定納税額）。年度ごとに保存
 *  - 第一表・第二表：事業所得は帳簿と決算書から。欄番号はその年分の様式（令和7年分と令和8年分の様式（案）は同じ。令和5・6年分は特定親族特別控除の欄が無く、令和6年分は定額減税の欄がある）
 *  - 決まりは年分の表（lib/incomeTax.ts の INCOME_TAX_RULES）。表に無い年分は、いちばん近い年分の決まりで計算して知らせる
 *  - 白色申告の年は、事業所得は収支内訳書の所得金額（事業専従者控除の後。lib/whiteStatement.ts）。事業専従者は配偶者・扶養親族の「専従者」の印で決め、
 *    従事月数・仕事の内容もここで入れる
 *  - 確定申告書（第一表・第二表）と青色申告決算書（白色は収支内訳書）を e-Tax のデータ（.xtx）で書き出す（作るのは lib/incomeTaxXtx.ts。
 *    決算書の数字は lib/blueStatement.ts・lib/whiteStatement.ts）。個人番号は書き出すときに入れてもらう（本人・配偶者・親族・事業専従者。保存しない）
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FileDown, Plus, Printer, Save, Trash2, Undo2, Wand2 } from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { AmountInput } from "../../components/Inputs";
import { useToast } from "../../components/Toast";
import { closingBalances, yearEnd, yearStart } from "../../lib/accounting";
import { todayIso, yen } from "../../lib/format";
import { filerFromSettings } from "../../lib/etax";
import { isYearCompliant } from "../../lib/ebook";
import { buildBlueStatement } from "../../lib/blueStatement";
import { buildWhiteStatement, businessMonths, familyMembers, type FamilyLine } from "../../lib/whiteStatement";
import { businessFigures } from "../../lib/incomeTaxBooks";
import { buildIncomeTaxXtx, incomeXtxNotices, incomeXtxProblems, myNumberPersons, type IncomeTaxXtxSource } from "../../lib/incomeTaxXtx";
import { MyNumberDialog } from "../../components/MyNumberDialog";
import { CODE } from "../../constants/accounts";
import {
  BLUE_DEDUCTION_LIMIT, CARRY_LABELS, carriedFromPast, carriedLosses, computeIncomeTax, dependentDeduction, fieldNo, reiwaYear, rulesFor, DEPENDENT_KIND_LABEL, DISABILITIES,
  DONATION_LOCALS, emptyRelative, EMPTY_INCOME_TAX_INPUT, spouseDeduction,
  type CarriedLoss, type Disability, type Donation, type IncomeTaxInput, type IncomeTaxResult, type MiscRow, type PastIncomeTax, type PayerRow, type PremiumRow,
  type Relative,
} from "../../lib/incomeTax";
import * as repo from "../../db/repo";

type View = "input" | "first" | "second" | "fourth";

const signed = (n: number) => (n < 0 ? `△${yen(-n)}` : yen(n));
const emptyPayer = (): PayerRow => ({ item: "", payer: "", payerId: "", income: 0, withheld: 0 });

/** 社会保険料・小規模企業共済等掛金として拾う、事業主貸の補助科目の名前 */
const SOCIAL_WORDS = /国民健康保険|国保|国民年金|介護保険|後期高齢者|健康保険|厚生年金/;
const SMALL_WORDS = /小規模企業共済|iDeCo|イデコ|確定拠出年金|心身障害者扶養共済/i;

export const IncomeTaxPage = () => {
  const { db, year, accounts, settings, subMap, counterparties, homeUseRates, isClosed, can, dataVersion, bump, filingTypeOf } = useAppContext();
  const filingType = filingTypeOf(year);
  const white = filingType === "white";
  const { lines, opening } = useYearData();
  const toast = useToast();
  const [view, setView] = useState<View>("input");
  const [saved, setSaved] = useState<IncomeTaxInput | null>(null);
  const [x, setX] = useState<IncomeTaxInput>(EMPTY_INCOME_TAX_INPUT);
  useEffect(() => {
    let alive = true;
    repo.getIncomeTaxInput(db, year).then((v) => {
      if (!alive) return;
      setSaved(v);
      setX(v);
    }).catch(console.error);
    return () => {
      alive = false;
    };
  }, [db, year, dataVersion]);
  const changed = saved !== null && JSON.stringify(x) !== JSON.stringify(saved);
  const admin = can("settings") && !isClosed;
  const set = <K extends keyof IncomeTaxInput>(k: K, v: IncomeTaxInput[K]) => setX((p) => ({ ...p, [k]: v }));

  // 事業所得（営業等）：帳簿と決算書から。白色申告は収支内訳書（専従者給与を経費にせず、事業専従者控除を差し引く）
  const end = useMemo(() => closingBalances(accounts, opening, lines), [accounts, opening, lines]);
  // 不動産所得：事業者設定の規模と、不動産所得用の決算書に書き込んだ「土地等を取得するために要した負債の利子の額」
  const [landInterest, setLandInterest] = useState(0);
  useEffect(() => {
    repo.getStatementNotes(db, year).then((n) => setLandInterest(Number((n["re:landInterest"] ?? "").replace(/[,\s円]/g, "")) || 0)).catch(console.error);
  }, [db, year, dataVersion]);
  const reScale = settings.real_estate ?? "none";
  const { biz, familyLines } = useMemo(
    () => businessFigures(accounts, end, filingType, x, year, { scale: reScale, landInterest }),
    [accounts, end, filingType, x, year, reScale, landInterest],
  );

  // 前の年から繰り越した純損失：前の年の申告（保存した所得税の入力と帳簿）から引き継ぐ。前の年の入力が無ければ null
  const [pastCarry, setPastCarry] = useState<CarriedLoss[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async (y: number): Promise<PastIncomeTax | null> => {
      const input = await repo.findIncomeTaxInput(db, y);
      if (!input) return null;
      const [l, o] = await Promise.all([repo.getLines(db, yearStart(y), yearEnd(y)), repo.getOpening(db, y)]);
      const n = await repo.getStatementNotes(db, y);
      const li = Number((n["re:landInterest"] ?? "").replace(/[,\s円]/g, "")) || 0;
      return { input, biz: businessFigures(accounts, closingBalances(accounts, o.byAccount, l), filingTypeOf(y), input, y, { scale: reScale, landInterest: li }).biz };
    };
    carriedFromPast(year, load).then((v) => alive && setPastCarry(v)).catch(console.error);
    return () => {
      alive = false;
    };
  }, [db, year, dataVersion, accounts, filingTypeOf, reScale]);
  const carried = useMemo(() => carriedLosses(x, year, pastCarry), [x, year, pastCarry]);
  const result = useMemo(() => computeIncomeTax(x, biz, year, carried), [x, biz, year, carried]);
  const fourth = result.loss.fourth;
  useEffect(() => {
    if (!fourth && view === "fourth") setView("first");
  }, [fourth, view]);

  // 事業主貸の補助科目ごとの合計（社会保険料などを拾うため）
  const drawings = useMemo(() => {
    const draw = accounts.find((a) => a.code === CODE.OWNER_DRAW);
    const m = new Map<number, number>();
    for (const l of lines) {
      if (l.is_deleted || l.account_id !== draw?.id || l.sub_account_id == null) continue;
      m.set(l.sub_account_id, (m.get(l.sub_account_id) ?? 0) + (l.side === "debit" ? l.amount : -l.amount));
    }
    return [...m.entries()].map(([id, amount]) => ({ name: subMap.get(id)?.name ?? "", amount })).filter((r) => r.name && r.amount > 0);
  }, [accounts, lines, subMap]);
  const pickFromBooks = () => {
    const add = (rows: PremiumRow[], re: RegExp) => [
      ...rows, ...drawings.filter((d) => re.test(d.name) && !rows.some((r) => r.kind === d.name)).map((d) => ({ kind: d.name, amount: d.amount })),
    ];
    const next = { ...x, socialInsurance: add(x.socialInsurance, SOCIAL_WORDS), smallBusiness: add(x.smallBusiness, SMALL_WORDS) };
    const n = next.socialInsurance.length + next.smallBusiness.length - x.socialInsurance.length - x.smallBusiness.length;
    setX(next);
    toast(n ? `事業主貸の補助科目から ${n} 行入れました（保存はまだです）` : "入れられる補助科目はありませんでした");
  };

  const save = async () => {
    try {
      await repo.saveIncomeTaxInput(db, year, x);
      bump();
      toast(`${year}年分の所得税の入力を保存しました`);
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };


  const pay = result.rows.find((r) => r.key === "pay")?.value ?? 0;
  const refund = result.rows.find((r) => r.key === "refund")?.value ?? 0;

  // e-Tax のデータ（.xtx）：確定申告書と青色申告決算書
  const filer = filerFromSettings(settings);
  const xtxProblems = incomeXtxProblems({ year, filer, input: x, result, biz });
  const [exportSrc, setExportSrc] = useState<IncomeTaxXtxSource | null>(null);
  const prepareExport = async () => {
    try {
      const [notes, assets, homeRun, depRun] = await Promise.all([
        repo.getStatementNotes(db, year), repo.getAssets(db), repo.getHomeUseRun(db, year), repo.getDepreciationRun(db, year),
      ]);
      const books = {
        year, accounts, opening, lines, notes, assets, homeUseRates,
        excludeEntryIds: [homeRun, depRun].filter((v): v is number => v !== null),
        payeeName: (r: { counterpartyId: number | null; subId: number | null }) =>
          r.counterpartyId ? counterparties.find((c) => c.id === r.counterpartyId)?.name ?? "（取引先）" : r.subId ? subMap.get(r.subId)?.name ?? "（補助科目）" : "（支払先の指定なし）",
        invoiceNoOf: (id: number) => counterparties.find((c) => c.id === id)?.invoice_no ?? "",
      };
      const statement = buildBlueStatement({ ...books, deductionLimit: BLUE_DEDUCTION_LIMIT[filingType] });
      const whiteSt = white ? buildWhiteStatement({ ...books, family: familyMembers(x), periodMonths: businessMonths(x.businessTax, year) }) : undefined;
      setExportSrc({
        year, filer, input: x, result, biz, statement, white: whiteSt, settings, numbers: {}, createdOn: todayIso(),
        bookKeeping: isYearCompliant(settings, year) && notes["ebook:filed"] ? 1 : 2,
      });
    } catch (e) {
      toast(`書き出せませんでした：${String(e).replace(/^Error: /, "")}`, "error");
    }
  };
  const exportXtx = async (numbers: Record<string, string>) => {
    const src = exportSrc;
    setExportSrc(null);
    if (!src) return;
    try {
      const xml = buildIncomeTaxXtx({ ...src, numbers });
      const path = await saveDialog({ defaultPath: `所得税申告_${year}年分.xtx`, filters: [{ name: "e-Tax のデータ", extensions: ["xtx"] }] });
      if (!path) return;
      await writeTextFile(path, xml);
      toast("e-Tax のデータを書き出しました");
    } catch (e) {
      toast(`書き出せませんでした：${String(e).replace(/^Error: /, "")}`, "error");
    }
  };
  const publicRefund = (result.rows.find((r) => r.no === fieldNo(53))?.value ?? 0) > 0 && filer.refund?.kind === "public";

  return (
    <div className="page">
      <PageHeader title="所得税" note={`${year}年分 所得税及び復興特別所得税の確定申告書の数字。事業所得は帳簿と決算書から出します。`}>
        <button className="btn ghost" onClick={() => window.print()} disabled={view === "input"}><Printer size={16} /> 印刷</button>
      </PageHeader>

      <div className="filters print-skip it-bar">
        <div className="seg" role="tablist">
          {([["input", "入力"], ["first", "第一表"], ["second", "第二表"], ...(fourth ? [["fourth", "第四表"]] : [])] as [View, string][]).map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{label}</button>
          ))}
        </div>
        <span className="it-balance">
          {pay > 0 ? <>納める税金 <b>{yen(pay)}円</b></> : refund > 0 ? <>還付される税金 <b>{yen(refund)}円</b></> : <>納める税金 <b>0円</b></>}
        </span>
        <span className="spacer" />
        {changed && <span className="muted">保存していない変更があります</span>}
        <button className="btn ghost" onClick={() => saved && setX(saved)} disabled={!changed}><Undo2 size={16} /> 戻す</button>
        <button className="btn primary" onClick={save} disabled={!admin || !changed}><Save size={16} /> 保存する</button>
        <button
          className="btn ghost" onClick={prepareExport} disabled={changed || xtxProblems.length > 0}
          title={changed ? "保存してから書き出してください" : xtxProblems.join("。")}
        >
          <FileDown size={16} /> e-Tax 用に書き出す
        </button>
      </div>
      {exportSrc && (
        <MyNumberDialog
          persons={[{ key: "self", label: settings.owner_name || "本人", required: publicRefund }, ...myNumberPersons(exportSrc)]}
          note={[
            publicRefund ? "公金受取口座で還付を受けるので、本人の個人番号が要ります。" : "入れない人は、個人番号の欄が空になります。",
            ...incomeXtxNotices(exportSrc).map((n) => `${n}。`),
          ].join("")}
          onSubmit={exportXtx} onClose={() => setExportSrc(null)}
        />
      )}
      {xtxProblems.length > 0 && !changed && (
        <p className="field-note print-skip it-xtx-note">e-Tax 用に書き出すには：{xtxProblems.join("。")}。</p>
      )}

      <section className="sheet sheet-fill">
        <div className="scroll-y">
          {result.notes.map((n) => <p key={n} className="notice it-note">{n}</p>)}
          {view === "input" ? (
            <InputView
              x={x} set={set} setX={setX} result={result} year={year} disabled={!admin} drawings={drawings.length > 0} onPick={pickFromBooks} white={white} familyLines={familyLines}
              pastCarry={pastCarry}
            />
          ) : view === "first" ? (
            <FirstTable result={result} year={year} />
          ) : view === "fourth" ? (
            <FourthTable result={result} year={year} />
          ) : (
            <SecondTable result={result} x={x} familySalary={biz.familySalary} white={white} familyLines={familyLines} />
          )}
        </div>
      </section>
    </div>
  );
};

// ────────────────────────────────────────────
// 入力
// ────────────────────────────────────────────

const Section = ({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) => (
  <div className="it-section">
    <h3 className="sheet-sub">{title}</h3>
    {children}
    {note && <p className="field-note">{note}</p>}
  </div>
);

const Amount = ({ value, onChange, disabled, label }: { value: number; onChange: (n: number) => void; disabled: boolean; label?: string }) => (
  <AmountInput value={value || null} onChange={(n) => onChange(n ?? 0)} disabled={disabled} aria-label={label} />
);

type Col<T> = { key: keyof T & string; label: string; kind: "text" | "amount" | "select"; width?: number; placeholder?: string; options?: [string, string][] };

/** 行を足し引きできる表 */
const RowsEditor = <T extends object>({ rows, cols, onChange, make, addLabel, disabled }: {
  rows: T[]; cols: Col<T>[]; onChange: (rows: T[]) => void; make: () => T; addLabel: string; disabled: boolean;
}) => {
  const update = (i: number, k: keyof T, v: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="it-rows">
      {rows.length > 0 && (
        <table className="ledger it-table">
          <thead>
            <tr>{cols.map((c) => <th key={c.key} className={c.kind === "amount" ? "num" : ""} style={c.width ? { width: c.width } : undefined}>{c.label}</th>)}<th style={{ width: 40 }} /></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c.key}>
                    {c.kind === "amount" ? (
                      <Amount value={r[c.key] as number} onChange={(n) => update(i, c.key, n)} disabled={disabled} label={c.label} />
                    ) : c.kind === "select" ? (
                      <select className="input" value={r[c.key] as string} onChange={(e) => update(i, c.key, e.target.value)} disabled={disabled} aria-label={c.label}>
                        {c.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    ) : (
                      <input className="input" value={r[c.key] as string} placeholder={c.placeholder} onChange={(e) => update(i, c.key, e.target.value)} disabled={disabled} aria-label={c.label} maxLength={100} />
                    )}
                  </td>
                ))}
                <td>
                  <button type="button" className="btn ghost sm icon" onClick={() => onChange(rows.filter((_, j) => j !== i))} disabled={disabled} aria-label="行を消す" title="行を消す"><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" className="btn ghost sm" onClick={() => onChange([...rows, make()])} disabled={disabled}><Plus size={14} /> {addLabel}</button>
    </div>
  );
};

const PAYER_COLS: Col<PayerRow>[] = [
  { key: "item", label: "種目", kind: "text", width: 120 },
  { key: "payer", label: "支払者の名称", kind: "text" },
  { key: "payerId", label: "法人番号又は所在地", kind: "text" },
  { key: "income", label: "収入金額", kind: "amount", width: 130 },
  { key: "withheld", label: "源泉徴収税額", kind: "amount", width: 130 },
];
const MISC_COLS: Col<MiscRow>[] = [
  { key: "kind", label: "区分", kind: "select", width: 90, options: [["business", "業務"], ["other", "その他"]] },
  { key: "item", label: "種目", kind: "text", width: 110 },
  { key: "payer", label: "支払者の名称", kind: "text" },
  { key: "income", label: "収入金額", kind: "amount", width: 120 },
  { key: "expenses", label: "必要経費", kind: "amount", width: 120 },
  { key: "withheld", label: "源泉徴収税額", kind: "amount", width: 120 },
];
const PREMIUM_COLS = (placeholder: string): Col<PremiumRow>[] => [
  { key: "kind", label: "種類", kind: "text", placeholder },
  { key: "amount", label: "支払った額", kind: "amount", width: 150 },
];

const InputView = ({ x, set, setX, result, year, disabled, drawings, onPick, white, familyLines, pastCarry }: {
  x: IncomeTaxInput; set: <K extends keyof IncomeTaxInput>(k: K, v: IncomeTaxInput[K]) => void; setX: (f: (p: IncomeTaxInput) => IncomeTaxInput) => void;
  result: IncomeTaxResult; year: number; disabled: boolean; drawings: boolean; onPick: () => void; white: boolean; familyLines: FamilyLine[];
  pastCarry: CarriedLoss[] | null;
}) => {
  const { rules } = rulesFor(year);
  const man = (n: number) => `${n / 10_000}万円`;
  return (
  <div className="it-input">
    <Section title="本人">
      <div className="field-row wrap">
        <label className="field" style={{ maxWidth: 180 }}>
          <span>生年月日</span>
          <input className="input" type="date" value={x.birthday} onChange={(e) => set("birthday", e.target.value)} disabled={disabled} />
        </label>
        <label className="field" style={{ maxWidth: 200 }}>
          <span>寡婦・ひとり親</span>
          <select className="input" value={x.widow} onChange={(e) => set("widow", e.target.value as IncomeTaxInput["widow"])} disabled={disabled}>
            <option value="none">どちらでもない</option>
            <option value="widow">寡婦</option>
            <option value="single_parent">ひとり親</option>
          </select>
        </label>
        <label className="field" style={{ maxWidth: 160 }}>
          <span>障害者</span>
          <select className="input" value={x.disability} onChange={(e) => set("disability", e.target.value as Disability)} disabled={disabled}>
            {DISABILITIES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </label>
        <label className="check" style={{ alignSelf: "flex-end" }}>
          <input type="checkbox" checked={x.student} onChange={(e) => set("student", e.target.checked)} disabled={disabled} /> 勤労学生
        </label>
      </div>
      <label className="field">
        <span>{reiwaYear(year + 1).replace("年分", "年")}1月1日の住所（今の住所と違うときだけ）</span>
        <input className="input" value={x.jan1Address} maxLength={100} onChange={(e) => set("jan1Address", e.target.value)} disabled={disabled} />
      </label>
    </Section>

    <Section title="事業所得（営業等）の源泉徴収" note="報酬・料金などで源泉徴収された収入を、支払者ごとに入れます（支払調書や請求書の控えから）。事業所得の金額そのものは、帳簿と決算書から出します。">
      <RowsEditor rows={x.businessWithholding} cols={PAYER_COLS} onChange={(v) => set("businessWithholding", v)} make={emptyPayer} addLabel="支払者を足す" disabled={disabled} />
    </Section>

    <Section title="給与" note="源泉徴収票の「支払金額」と「源泉徴収税額」を入れます。源泉徴収票の社会保険料・生命保険料などは、下の所得控除の欄に入れてください。">
      <RowsEditor rows={x.salaries} cols={PAYER_COLS} onChange={(v) => set("salaries", v)} make={emptyPayer} addLabel="給与の支払者を足す" disabled={disabled} />
    </Section>

    <Section title="雑所得（公的年金等）" note="公的年金等の源泉徴収票の「支払金額」と「源泉徴収税額」。65歳以上かどうかは本人の生年月日で決めます。">
      <RowsEditor rows={x.pensions} cols={PAYER_COLS} onChange={(v) => set("pensions", v)} make={emptyPayer} addLabel="年金の支払者を足す" disabled={disabled} />
    </Section>

    <Section title="雑所得（業務・その他）" note="業務：副業の原稿料・講演料など事業と言えないもの。その他：暗号資産など。損失はほかの所得から差し引けません。">
      <RowsEditor rows={x.misc} cols={MISC_COLS} onChange={(v) => set("misc", v)} make={(): MiscRow => ({ ...emptyPayer(), kind: "business", expenses: 0 })} addLabel="雑所得を足す" disabled={disabled} />
    </Section>

    <CarrySection x={x} set={set} result={result} year={year} disabled={disabled} pastCarry={pastCarry} />

    <Section title="社会保険料・小規模企業共済等掛金" note="国民健康保険・国民年金・介護保険など（家族の分を払ったものも含む）と、小規模企業共済・iDeCo など。事業主貸に補助科目を作って記帳していれば、名前から拾えます。">
      <RowsEditor rows={x.socialInsurance} cols={PREMIUM_COLS("例：国民年金")} onChange={(v) => set("socialInsurance", v)} make={() => ({ kind: "", amount: 0 })} addLabel="社会保険料を足す" disabled={disabled} />
      <div style={{ height: 8 }} />
      <RowsEditor rows={x.smallBusiness} cols={PREMIUM_COLS("例：小規模企業共済")} onChange={(v) => set("smallBusiness", v)} make={() => ({ kind: "", amount: 0 })} addLabel="小規模企業共済等掛金を足す" disabled={disabled} />
      {drawings && <button type="button" className="btn ghost sm it-pick" onClick={onPick} disabled={disabled}><Wand2 size={14} /> 事業主貸の補助科目から入れる</button>}
    </Section>

    <Section title="生命保険料・地震保険料" note={`控除証明書の「本年中の支払額」（剰余金・割戻金を差し引いた額）。新＝平成24年以後の契約、旧＝平成23年以前の契約。${rules.lifeUnder23 ? "23歳未満の扶養親族がいれば、新生命保険料は上限6万円で計算します（令和8年分から）。" : ""}`}>
      <div className="field-row wrap it-amounts">
        {([["newLife", "新生命保険料"], ["oldLife", "旧生命保険料"], ["care", "介護医療保険料"], ["newPension", "新個人年金保険料"], ["oldPension", "旧個人年金保険料"]] as [keyof IncomeTaxInput["life"], string][]).map(([k, label]) => (
          <label key={k} className="field">
            <span>{label}</span>
            <Amount value={x.life[k]} onChange={(n) => set("life", { ...x.life, [k]: n })} disabled={disabled} />
          </label>
        ))}
        <label className="field">
          <span>地震保険料</span>
          <Amount value={x.quake.quake} onChange={(n) => set("quake", { ...x.quake, quake: n })} disabled={disabled} />
        </label>
        <label className="field">
          <span>旧長期損害保険料</span>
          <Amount value={x.quake.oldLong} onChange={(n) => set("quake", { ...x.quake, oldLong: n })} disabled={disabled} />
        </label>
      </div>
    </Section>

    <Section title="医療費" note={`医療費控除は「支払った医療費 − 補填される金額 − 10万円（総所得金額等の5%が少なければその額）」、200万円まで。セルフメディケーション税制は対象の医薬品の購入費から1万2千円を引いた額（8万8千円まで）。どちらか一方です。申告には医療費控除の明細書（またはセルフメディケーション税制の明細書）が要ります。`}>
      <div className="field-row wrap it-amounts">
        <label className="field">
          <span>控除の種類</span>
          <select className="input" value={x.medical.kind} onChange={(e) => set("medical", { ...x.medical, kind: e.target.value as "normal" | "self" })} disabled={disabled}>
            <option value="normal">医療費控除</option>
            <option value="self">セルフメディケーション税制</option>
          </select>
        </label>
        <label className="field">
          <span>{x.medical.kind === "self" ? "対象の医薬品の購入費" : "支払った医療費"}</span>
          <Amount value={x.medical.paid} onChange={(n) => set("medical", { ...x.medical, paid: n })} disabled={disabled} />
        </label>
        <label className="field">
          <span>保険金などで補填される金額</span>
          <Amount value={x.medical.reimbursed} onChange={(n) => set("medical", { ...x.medical, reimbursed: n })} disabled={disabled} />
        </label>
      </div>
    </Section>

    <Section title="寄附金（ふるさと納税など）" note="寄附金の合計から2千円を引いた額（総所得金額等の40%まで）を控除します。ワンストップ特例は確定申告をすると使えなくなるので、その分もここに入れてください。「住民税の寄附金税額控除」は、第二表の住民税の欄に書く区分です（ふるさと納税など＝都道府県・市区町村への寄附。条例指定は、住所地の都道府県・市区町村が条例で指定した寄附金）。">
      <RowsEditor
        rows={x.donations}
        cols={[
          { key: "name", label: "寄附先の名称等", kind: "text" }, { key: "amount", label: "寄附金", kind: "amount", width: 150 },
          { key: "local", label: "住民税の寄附金税額控除", kind: "select", width: 260, options: DONATION_LOCALS },
        ] satisfies Col<Donation>[]}
        onChange={(v) => set("donations", v)} make={(): Donation => ({ name: "", amount: 0, local: "" })} addLabel="寄附先を足す" disabled={disabled}
      />
    </Section>

    <Section title="配偶者" note={`配偶者の合計所得金額が${man(rules.dependentLimit)}以下なら配偶者控除、${man(rules.dependentLimit)}超133万円以下なら配偶者特別控除です（本人の合計所得金額が1,000万円以下のとき）。給与だけなら、給与所得控除後の金額が合計所得金額です。専従者給与を受けている人（事業専従者）は、配偶者控除・扶養控除の対象になりません（「専従者」に印）。`}>
      {x.spouse ? (
        <RelativesEditor rows={[x.spouse]} onChange={([s]) => set("spouse", s ?? null)} year={year} ownIncome={result.totalIncome} spouse disabled={disabled} />
      ) : (
        <button type="button" className="btn ghost sm" onClick={() => set("spouse", emptyRelative("妻"))} disabled={disabled}><Plus size={14} /> 配偶者を入れる</button>
      )}
    </Section>

    <Section title="扶養親族" note={`生計を一にする親族（16歳未満の子も、障害者控除${rules.lifeUnder23 ? "と生命保険料の特例" : ""}のために入れてください）。合計所得金額が${man(rules.dependentLimit)}以下なら扶養控除${rules.specificRelative ? `、19歳以上23歳未満で${man(rules.dependentLimit)}超123万円以下なら特定親族特別控除` : ""}です（${reiwaYear(rules.year)}の決まり）。${rules.flatCut ? "定額減税（令和6年分特別税額控除）は、本人と、この欄・配偶者の欄の所得要件を満たす人（事業専従者を除く）1人につき3万円です。" : ""}`}>
      <RelativesEditor rows={x.dependents} onChange={(v) => setX((p) => ({ ...p, dependents: v }))} year={year} ownIncome={result.totalIncome} disabled={disabled} />
    </Section>

    {white && (
      <Section
        title="事業専従者（白色申告）"
        note="配偶者・扶養親族で「専従者」に印を付けた人です。控除額は1人につき、86万円（配偶者以外は50万円）と、収支内訳書の専従者控除前の所得金額 ÷（事業専従者の数＋1）の少ない方です。12月31日に15歳以上で、その年に6か月を超えて（年の中途に開業・廃業したときは事業の期間の2分の1を超えて）事業に専ら従事した人が対象です。従事の程度・仕事の内容は第二表に書きます（例：毎日・経理）。"
      >
        <FamilyEditor x={x} setX={setX} lines={familyLines} disabled={disabled} />
      </Section>
    )}

    <Section title="税額控除・予定納税" note="住宅借入金等特別控除は、計算明細書で計算した額を入れます（所得税額が上限）。予定納税額は、税務署から通知された第1期分と第2期分の合計です。">
      <div className="field-row wrap it-amounts">
        <label className="field">
          <span>住宅借入金等特別控除額</span>
          <Amount value={x.housingLoan} onChange={(n) => set("housingLoan", n)} disabled={disabled} />
        </label>
        <label className="field">
          <span>予定納税額（第1期分・第2期分）</span>
          <Amount value={x.prepaid} onChange={(n) => set("prepaid", n)} disabled={disabled} />
        </label>
      </div>
    </Section>

    <Section title="住民税・事業税に関する事項" note="第二表の「住民税・事業税に関する事項」に書きます。住民税の徴収方法は、給与・公的年金等以外の所得（事業所得など）に係る住民税を、給与から差し引くか、自分で納付するかです。ふるさと納税などの寄附金は、上の寄附金の欄で住民税の区分を選びます。事業税の開業・廃業は、その年の中途に開業・廃業したときだけ入れます（決算書の事業期間にも使います）。">
      <div className="field-row wrap">
        <label className="field" style={{ maxWidth: 260 }}>
          <span>住民税の徴収方法</span>
          <select className="input" value={x.residentTax} onChange={(e) => set("residentTax", e.target.value as IncomeTaxInput["residentTax"])} disabled={disabled}>
            <option value="">書かない</option>
            <option value="special">特別徴収（給与から差し引き）</option>
            <option value="self">自分で納付</option>
          </select>
        </label>
        <label className="field" style={{ maxWidth: 180 }}>
          <span>事業税：開業・廃業</span>
          <select className="input" value={x.businessTax.change} onChange={(e) => set("businessTax", { ...x.businessTax, change: e.target.value as IncomeTaxInput["businessTax"]["change"] })} disabled={disabled}>
            <option value="">なし</option>
            <option value="open">開業</option>
            <option value="close">廃業</option>
          </select>
        </label>
        {x.businessTax.change && (
          <label className="field" style={{ maxWidth: 180 }}>
            <span>{x.businessTax.change === "open" ? "開業" : "廃業"}した日</span>
            <input className="input" type="date" value={x.businessTax.changeDate} onChange={(e) => set("businessTax", { ...x.businessTax, changeDate: e.target.value })} disabled={disabled} />
          </label>
        )}
        <label className="check" style={{ alignSelf: "flex-end" }}>
          <input type="checkbox" checked={x.businessTax.otherPrefecture} onChange={(e) => set("businessTax", { ...x.businessTax, otherPrefecture: e.target.checked })} disabled={disabled} /> 他の都道府県に事務所等がある
        </label>
      </div>
    </Section>
  </div>
  );
};

/** 白色の事業専従者の従事月数・仕事の内容（配偶者・扶養親族の欄に持つ） */
const FamilyEditor = ({ x, setX, lines, disabled }: {
  x: IncomeTaxInput; setX: (f: (p: IncomeTaxInput) => IncomeTaxInput) => void; lines: FamilyLine[]; disabled: boolean;
}) => {
  const update = (from: string, patch: Partial<Relative>) => setX((p) => from === "spouse"
    ? { ...p, spouse: p.spouse ? { ...p.spouse, ...patch } : null }
    : { ...p, dependents: p.dependents.map((d, i) => (`dep${i}` === from ? { ...d, ...patch } : d)) });
  const personOf = (from: string) => (from === "spouse" ? x.spouse : x.dependents[Number(from.slice(3))]);
  if (lines.length === 0) return <p className="field-note">いません（配偶者・扶養親族の欄で「専従者」に印を付けると、ここに出ます）。</p>;
  return (
    <table className="ledger it-table">
      <thead>
        <tr><th>氏名</th><th style={{ width: 80 }}>続柄</th><th className="num" style={{ width: 70 }}>年齢</th><th style={{ width: 110 }}>従事月数</th><th>従事の程度・仕事の内容</th><th className="num" style={{ width: 120 }}>控除額</th><th>備考</th></tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.from}>
            <td>{l.name}</td>
            <td>{l.relation}</td>
            <td className="num">{l.age === null ? "" : `${l.age}歳`}</td>
            <td>
              <select className="input" value={personOf(l.from)?.months ?? ""} onChange={(e) => update(l.from, { months: e.target.value ? Number(e.target.value) : null })} disabled={disabled} aria-label="従事月数">
                <option value="">—</option>
                {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}か月</option>)}
              </select>
            </td>
            <td><input className="input" value={personOf(l.from)?.work ?? ""} onChange={(e) => update(l.from, { work: e.target.value })} disabled={disabled} aria-label="従事の程度・仕事の内容" maxLength={40} placeholder="例：毎日・経理" /></td>
            <td className="num">{yen(l.deduction)}</td>
            <td>{l.problem ? <span className="balance-ng">{l.problem}</span> : <span className="muted">{l.spouse ? "配偶者 86万円まで" : "50万円まで"}</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const RelativesEditor = ({ rows, onChange, year, ownIncome, spouse, disabled }: {
  rows: Relative[]; onChange: (rows: Relative[]) => void; year: number; ownIncome: number; spouse?: boolean; disabled: boolean;
}) => {
  const update = (i: number, patch: Partial<Relative>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const kindOf = (r: Relative) => {
    if (spouse) {
      const s = spouseDeduction(r, ownIncome, year);
      return s.kind === "spouse" ? `配偶者控除 ${yen(s.amount)}円` : s.kind === "special" ? `配偶者特別控除 ${yen(s.amount)}円` : r.familyEmployee ? "控除なし（事業専従者）" : "控除なし";
    }
    const d = dependentDeduction(r, year);
    return `${DEPENDENT_KIND_LABEL[d.kind]}${d.amount ? ` ${yen(d.amount)}円` : ""}`;
  };
  return (
    <div className="it-rows">
      {rows.length > 0 && (
        <table className="ledger it-table">
          <thead>
            <tr>
              <th>氏名</th><th style={{ width: 80 }}>続柄</th><th style={{ width: 140 }}>生年月日</th><th className="num" style={{ width: 120 }}>合計所得金額</th>
              <th style={{ width: 110 }}>障害者</th><th style={{ width: 56 }}>同居</th>{!spouse && <th style={{ width: 70 }}>直系尊属</th>}<th style={{ width: 56 }} title="青色事業専従者として給与を受ける人・白色の事業専従者">専従者</th><th>控除</th><th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><input className="input" value={r.name} onChange={(e) => update(i, { name: e.target.value })} disabled={disabled} aria-label="氏名" maxLength={50} /></td>
                <td><input className="input" value={r.relation} onChange={(e) => update(i, { relation: e.target.value })} disabled={disabled} aria-label="続柄" maxLength={20} /></td>
                <td><input className="input" type="date" value={r.birthday} onChange={(e) => update(i, { birthday: e.target.value })} disabled={disabled} aria-label="生年月日" /></td>
                <td><Amount value={r.income} onChange={(n) => update(i, { income: n })} disabled={disabled} label="合計所得金額" /></td>
                <td>
                  <select className="input" value={r.disability} onChange={(e) => update(i, { disability: e.target.value as Disability })} disabled={disabled} aria-label="障害者">
                    {DISABILITIES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select>
                </td>
                <td className="center"><input type="checkbox" checked={r.cohabiting} onChange={(e) => update(i, { cohabiting: e.target.checked })} disabled={disabled} aria-label="同居" /></td>
                {!spouse && <td className="center"><input type="checkbox" checked={r.lineal} onChange={(e) => update(i, { lineal: e.target.checked })} disabled={disabled} aria-label="直系尊属" /></td>}
                <td className="center"><input type="checkbox" checked={r.familyEmployee} onChange={(e) => update(i, { familyEmployee: e.target.checked })} disabled={disabled} aria-label="事業専従者" /></td>
                <td className="muted">{kindOf(r)}</td>
                <td>
                  <button type="button" className="btn ghost sm icon" onClick={() => onChange(rows.filter((_, j) => j !== i))} disabled={disabled} aria-label="消す" title="消す"><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!spouse && <button type="button" className="btn ghost sm" onClick={() => onChange([...rows, emptyRelative("子")])} disabled={disabled}><Plus size={14} /> 扶養親族を足す</button>}
    </div>
  );
};

/** 前の年から繰り越した純損失（第四表（二）の「4 繰越損失を差し引く計算」）。前の年の申告から引き継ぐか、手で入れる */
const CarrySection = ({ x, set, result, year, disabled, pastCarry }: {
  x: IncomeTaxInput; set: <K extends keyof IncomeTaxInput>(k: K, v: IncomeTaxInput[K]) => void; result: IncomeTaxResult; year: number; disabled: boolean;
  pastCarry: CarriedLoss[] | null;
}) => {
  const manual = x.carry.mode === "manual";
  const loss = result.loss;
  const rows = loss.carry.map((c, i) => ({ ...c, label: `${reiwaYear(c.year)}（${CARRY_LABELS[i]}）` })).filter((c) => manual || c.before > 0);
  const setMode = (mode: IncomeTaxInput["carry"]["mode"]) => set("carry", { ...x.carry, mode });
  const setAmount = (i: number, n: number) => set("carry", { ...x.carry, amounts: x.carry.amounts.map((v, j) => (j === i ? n : v)) as [number, number, number] });
  return (
    <Section
      title="繰越損失（前の年までの純損失）"
      note="青色申告の年の純損失（事業などの赤字を、給与などのほかの所得から差し引いても残った額）は、翌年以後3年間に繰り越して、古い年分から順に差し引けます。損失が出た年から毎年続けて確定申告書を出していることが要ります。白色申告の年の純損失（変動所得・被災事業用資産の損失）と雑損失は domble では扱いません。"
    >
      <div className="field-row wrap">
        <label className="check"><input type="radio" name="carry-mode" checked={!manual} onChange={() => setMode("auto")} disabled={disabled} /> 前の年の申告から引き継ぐ</label>
        <label className="check"><input type="radio" name="carry-mode" checked={manual} onChange={() => setMode("manual")} disabled={disabled} /> 手で入れる（前の年の第四表（二）から写す）</label>
      </div>
      {!manual && (
        <p className="muted">
          {pastCarry === null
            ? `${reiwaYear(year - 1)}の所得税の入力が domble にありません。前の年に純損失を繰り越していれば、「手で入れる」にして、前の年の第四表（二）から写してください。`
            : rows.length === 0 ? `${reiwaYear(year - 1)}の申告から繰り越された純損失はありません。` : `${reiwaYear(year - 1)}の申告（domble の所得税の入力と帳簿）から引き継いでいます。`}
        </p>
      )}
      {rows.length > 0 && (
        <table className="ledger it-table it-carry">
          <thead>
            <tr><th>損失が出た年分</th><th className="num">Ⓐ前年分までに引ききれなかった損失額</th><th className="num">Ⓑ本年分で差し引く損失額</th><th className="num">Ⓒ翌年分以後に繰り越す額</th></tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const i = c.year - (year - 3);
              return (
                <tr key={c.year}>
                  <td>{c.label}</td>
                  <td className="num">{manual ? <Amount value={x.carry.amounts[i]} onChange={(n) => setAmount(i, n)} disabled={disabled} label={`${c.label}の繰越損失`} /> : yen(c.before)}</td>
                  <td className="num">{yen(c.used)}</td>
                  <td className="num">{c.after === null ? <span className="muted">繰り越せません</span> : yen(c.after)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {loss.blueLoss > 0 && <p className="field-note">本年の純損失 {yen(loss.blueLoss)}円は、翌年分に繰り越します（第四表の (82)）。</p>}
    </Section>
  );
};

// ────────────────────────────────────────────
// 第一表・第二表・第四表
// ────────────────────────────────────────────

const FirstTable = ({ result, year }: { result: IncomeTaxResult; year: number }) => (
  <div className="print-area">
    <h3 className="sheet-sub">{year}年分 所得税及び復興特別所得税の確定申告書 第一表の数字</h3>
    <table className="ledger tax-form-table it-first">
      <colgroup><col style={{ width: 60 }} /><col /><col style={{ width: 150 }} /><col style={{ width: "34%" }} /></colgroup>
      <thead><tr><th>欄</th><th>項目</th><th className="num">金額</th><th>備考</th></tr></thead>
      <tbody>
        {result.rows.map((r, i) => r.head ? (
          <tr key={i} className="cat-row"><td colSpan={4}>{r.label}</td></tr>
        ) : (
          <tr key={i} className={r.key === "pay" || r.key === "refund" || r.key === "total" ? "st-strong" : ""}>
            <td className="tax-form-no">{r.no}</td>
            <td>{r.label}</td>
            <td className="num"><b>{r.value === null ? "" : signed(r.value)}</b></td>
            <td className="muted">{r.note ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <p className="field-note">
      欄番号は{rulesFor(year).rules.form === "r7" ? "令和7年分の様式と令和8年分の様式（案）で同じ" : `${reiwaYear(rulesFor(year).rules.year)}の様式のもの`}です。数字の入っていない欄（農業・不動産・利子・配当・譲渡・一時所得、雑損控除、配当控除などの税額控除、災害減免額、外国税額控除）は domble では扱いません。
      確定申告書等作成コーナーや e-Tax に書き写すときに使ってください。
    </p>
  </div>
);

const Row = ({ no, label, value, note }: { no: string; label: string; value: number; note?: string }) => (
  <tr><td className="tax-form-no">{no}</td><td>{label}</td><td className="num"><b>{signed(value)}</b></td><td className="muted">{note ?? ""}</td></tr>
);

/** 第四表（損失申告用）：domble が扱う所得は経常所得だけなので、(67)・(81)・(82)・4 の繰越損失・(93) */
const FourthTable = ({ result, year }: { result: IncomeTaxResult; year: number }) => {
  const l = result.loss;
  return (
    <div className="print-area">
      <h3 className="sheet-sub">{year}年分 所得税及び復興特別所得税の確定申告書（損失申告用）第四表の数字</h3>
      <table className="ledger tax-form-table it-first">
        <colgroup><col style={{ width: 60 }} /><col /><col style={{ width: 150 }} /><col style={{ width: "34%" }} /></colgroup>
        <thead><tr><th>欄</th><th>項目</th><th className="num">金額</th><th>備考</th></tr></thead>
        <tbody>
          <tr className="cat-row"><td colSpan={4}>第四表（一）　1 損失額又は所得金額・2 損益の通算</td></tr>
          <Row no={fieldNo(67)} label="経常所得（第一表の①から⑥までの計＋⑩）" value={l.income} note="通算前・第1次〜第3次通算後・損失額又は所得金額も同じ額" />
          <Row no={fieldNo(81)} label="損失額又は所得金額の合計額" value={l.income} note="譲渡・一時・山林・退職の所得は domble では扱いません" />
          <tr className="cat-row"><td colSpan={4}>第四表（二）　3 翌年以後に繰り越す損失額</td></tr>
          <Row no={fieldNo(82)} label="青色申告者の損失の金額" value={l.blueLoss} note={l.blueLoss ? "(81) の赤字" : undefined} />
          <tr className="cat-row"><td colSpan={4}>4 繰越損失を差し引く計算（純損失・青色の年・山林以外の所得の損失）</td></tr>
        </tbody>
      </table>
      <table className="ledger it-table it-carry">
        <thead>
          <tr><th>年分</th><th className="num">Ⓐ前年分までに引ききれなかった損失額</th><th className="num">Ⓑ本年分で差し引く損失額</th><th className="num">Ⓒ翌年分以後に繰り越して差し引かれる損失額</th></tr>
        </thead>
        <tbody>
          {l.carry.map((c, i) => (
            <tr key={c.year}>
              <td>{"ABC"[i]}　{reiwaYear(c.year)}（{CARRY_LABELS[i]}）</td>
              <td className="num">{c.before ? yen(c.before) : ""}</td>
              <td className="num">{c.before ? yen(c.used) : ""}</td>
              <td className="num">{c.after === null ? "" : c.before ? yen(c.after) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="ledger tax-form-table it-first">
        <colgroup><col style={{ width: 60 }} /><col /><col style={{ width: 150 }} /><col style={{ width: "34%" }} /></colgroup>
        <tbody>
          <Row no={fieldNo(93)} label="雑損控除、医療費控除及び寄附金控除の計算で使用する所得金額の合計額" value={l.forDeductions} note="(81) の黒字から本年分で差し引く損失額を引いた額" />
        </tbody>
      </table>
      <p className="field-note">
        第四表は第一表・第二表と一緒に出します。第一表の ⑫ と課税される所得金額は書かず、その税額は 0 です（損失申告用の手引き）。{rulesFor(year).rules.form !== "r7" && "第四表の欄番号は令和7年分の様式のものです（年分の様式で確かめてください）。"}
        翌年は、Ⓒ の額と (82) の額が「前年分までに引ききれなかった損失額」になります（domble で翌年の申告を作れば引き継ぎます）。
      </p>
    </div>
  );
};

const SecondTable = ({ result, x, familySalary, white, familyLines }: {
  result: IncomeTaxResult; x: IncomeTaxInput; familySalary: number; white: boolean; familyLines: FamilyLine[];
}) => {
  const s = result.second;
  const withheldTotal = s.withholding.reduce((t, r) => t + r.withheld, 0);
  const disabilityLabel = (d: Disability) => DISABILITIES.find((v) => v.value === d)?.label ?? "";
  return (
    <div className="print-area it-second">
      <h3 className="sheet-sub">所得の内訳（所得税及び復興特別所得税の源泉徴収税額）</h3>
      {s.withholding.length ? (
        <table className="ledger tax-form-table">
          <thead><tr><th>所得の種類</th><th>種目</th><th>支払者の名称</th><th>法人番号又は所在地</th><th className="num">収入金額</th><th className="num">源泉徴収税額</th></tr></thead>
          <tbody>
            {s.withholding.map((r, i) => (
              <tr key={i}><td>{r.kind}</td><td>{r.item}</td><td>{r.payer}</td><td>{r.payerId}</td><td className="num">{yen(r.income)}</td><td className="num">{yen(r.withheld)}</td></tr>
            ))}
            <tr className="st-strong"><td colSpan={5}>㊾ 源泉徴収税額の合計額</td><td className="num">{yen(withheldTotal)}</td></tr>
          </tbody>
        </table>
      ) : <p className="field-note">源泉徴収された収入はありません。</p>}

      <h3 className="sheet-sub">⑬ 社会保険料控除・⑭ 小規模企業共済等掛金控除</h3>
      {[...s.socialInsurance.map((r) => ["⑬", r] as const), ...s.smallBusiness.map((r) => ["⑭", r] as const)].length ? (
        <table className="ledger tax-form-table">
          <thead><tr><th style={{ width: 50 }}>欄</th><th>保険料等の種類</th><th className="num">支払保険料等の計</th></tr></thead>
          <tbody>
            {[...s.socialInsurance.map((r) => ["⑬", r] as const), ...s.smallBusiness.map((r) => ["⑭", r] as const)].map(([no, r], i) => (
              <tr key={i}><td className="tax-form-no">{no}</td><td>{r.kind}</td><td className="num">{yen(r.amount)}</td></tr>
            ))}
          </tbody>
        </table>
      ) : <p className="field-note">ありません。</p>}

      <h3 className="sheet-sub">⑮ 生命保険料控除・⑯ 地震保険料控除</h3>
      <dl className="kv it-kv">
        <dt>新生命保険料</dt><dd className="num">{yen(s.life.newLife)}</dd>
        <dt>旧生命保険料</dt><dd className="num">{yen(s.life.oldLife)}</dd>
        <dt>新個人年金保険料</dt><dd className="num">{yen(s.life.newPension)}</dd>
        <dt>旧個人年金保険料</dt><dd className="num">{yen(s.life.oldPension)}</dd>
        <dt>介護医療保険料</dt><dd className="num">{yen(s.life.care)}</dd>
        <dt>地震保険料</dt><dd className="num">{yen(s.quake.quake)}</dd>
        <dt>旧長期損害保険料</dt><dd className="num">{yen(s.quake.oldLong)}</dd>
      </dl>

      <h3 className="sheet-sub">本人に関する事項（⑰〜⑳）</h3>
      <p className="it-plain">
        {[x.widow === "widow" ? "寡婦" : x.widow === "single_parent" ? "ひとり親" : "", x.student ? "勤労学生" : "", x.disability !== "none" ? disabilityLabel(x.disability) : ""].filter(Boolean).join("・") || "該当なし"}
      </p>

      <h3 className="sheet-sub">㉙ 寄附金控除に関する事項</h3>
      {s.donations.length ? (
        <table className="ledger tax-form-table">
          <thead><tr><th>寄附先の名称等</th><th className="num">寄附金</th></tr></thead>
          <tbody>{s.donations.map((d, i) => <tr key={i}><td>{d.name}</td><td className="num">{yen(d.amount)}</td></tr>)}</tbody>
        </table>
      ) : <p className="field-note">ありません。</p>}

      <h3 className="sheet-sub">配偶者や親族に関する事項</h3>
      {s.relatives.length ? (
        <table className="ledger tax-form-table">
          <thead><tr><th>氏名</th><th>続柄</th><th>生年月日</th><th>障害者</th><th>同居</th><th>控除</th></tr></thead>
          <tbody>
            {s.relatives.map((r, i) => (
              <tr key={i}>
                <td>{r.name}</td><td>{r.relation}</td><td>{r.birthday}</td>
                <td>{r.disability === "none" ? "" : disabilityLabel(r.disability)}</td><td>{r.cohabiting ? "同居" : "別居"}</td><td>{r.kind}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="field-note">ありません。</p>}

      <h3 className="sheet-sub">事業専従者に関する事項（(58)）</h3>
      {white ? (
        familyLines.some((l) => l.deduction > 0) ? (
          <table className="ledger tax-form-table">
            <thead><tr><th>氏名</th><th>続柄</th><th>生年月日</th><th>従事月数・程度・仕事の内容</th><th className="num">専従者控除額</th></tr></thead>
            <tbody>
              {familyLines.filter((l) => l.deduction > 0).map((l) => (
                <tr key={l.from}>
                  <td>{l.name}</td><td>{l.relation}</td><td>{l.birthday}</td>
                  <td>{[l.months ? `${l.months}月` : "", l.work].filter(Boolean).join("・")}</td><td className="num">{yen(l.deduction)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={4}>(58) 専従者給与（控除）額の合計額</td><td className="num">{yen(familySalary)}</td></tr></tfoot>
          </table>
        ) : <p className="field-note">ありません。</p>
      ) : (
        <p className="it-plain">専従者給与の合計額：{yen(familySalary)}円（氏名・従事月数は決算書の「月別売上・給料など」に書き込んだもの）</p>
      )}

      <p className="field-note">
        個人番号は domble に保存しません（e-Tax 用のデータを書き出すときに入れます）。住民税・事業税に関する事項は、入力の「住民税・事業税に関する事項」で入れたものを書き出します。
      </p>
    </div>
  );
};
