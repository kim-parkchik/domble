/**
 * 消費税の申告書の数字（「消費税」の画面の「申告書」タブ。計算は lib/taxReturn.ts）
 *  - 方式の比較：その年に使える方式（本則・簡易・2割特例・3割特例）の納付税額を並べる
 *  - 選んだ方式の付表・第二表・第一表を、欄の番号つきで出す（確定申告書等作成コーナーや e-Tax に書き写す）
 *  - 中間納付税額は年度ごとに入れる（前年の実績で計算した中間申告の額を「判定した額を入れる」で入れられる）
 *  - 本則課税の棚卸資産の調整（付表2-3 ⑯）は年度ごとに、税率・控除できる割合ごとの取得価額を入れる
 *  - 選んだ方式の申告書を e-Tax のデータ（.xtx）で書き出す（作るのは lib/taxXtx.ts。申告者の情報は事業者設定から）
 *  - 一般用で ⑧ 控除不足還付税額があるときは、還付申告に関する明細書を出して保存し、e-Tax のデータにも入れる（RefundDetailSection.tsx）
 */
import { useEffect, useMemo, useState } from "react";
import { FileDown, Plus, Printer, Save, Trash2, Wand2 } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAppContext, useBaseSales, useInterim, useYearData } from "../../context/AppContext";
import { InterimFillButton } from "./TaxInterimView";
import { methodProblem } from "../../lib/baseSales";
import { useToast } from "../../components/Toast";
import { todayIso, yen } from "../../lib/format";
import { filerFromSettings, filerProblems } from "../../lib/etax";
import { buildTaxXtx, refundShortfall, xtxProblem, xtxVersionFor } from "../../lib/taxXtx";
import { purchaseFigures, refundDetailFromBooks } from "../../lib/taxRefundDetail";
import { RefundDetailSection, useRefundDetail } from "./RefundDetailSection";
import {
  buildTaxBase, computeReturn, inventoryAdjustTax, inventoryOf, methodsFor, METHOD_LABEL, thirtyReturn, twentyReturn,
  type InventoryAdjust, type Rate, type ReturnMethod, type TaxForm, type TaxReturn,
} from "../../lib/taxReturn";
import { closingBalances, type FlatLine } from "../../lib/accounting";
import { taxYearOf } from "../../lib/tax";
import type { OpeningBalances } from "../../lib/types";
import { AmountInput } from "../../components/Inputs";
import * as repo from "../../db/repo";
import { MyNumberDialog } from "../../components/MyNumberDialog";

/** 方式ごとの、使うための主な条件 */
const METHOD_NOTE: Record<ReturnMethod, string> = {
  standard: "帳簿とインボイスなどの請求書の保存が要ります",
  simplified: "簡易課税制度選択届出書が要ります（基準期間の課税売上高が5,000万円以下）",
  twenty: "登録によって課税事業者になった方（基準期間の課税売上高が1,000万円以下など）。届出は不要",
  thirty: "登録によって課税事業者になった個人事業者（基準期間の課税売上高が1,000万円以下など）。届出は不要",
};

const signed = (n: number) => (n < 0 ? `△${yen(-n)}` : yen(n));

/**
 * その年の課税区分で計算した申告書（決算整理の未払消費税等に使う。免税事業者の年・読み込み中は null）。
 * 中間納付税額・棚卸資産の調整・基準期間の課税売上高は、申告書タブで保存したもの
 */
export const useYearReturn = (): TaxReturn | null => {
  const { db, year, taxYears, taxYear, dataVersion } = useAppContext();
  const { rawLines: lines, opening } = useYearData(); // 消費税は入れたとおりの明細（税込）から
  const inv = useInventory(lines, opening);
  const baseSales = useBaseSales();
  const [interim, setInterim] = useState<{ national: number; local: number } | null>(null);
  const [extra, setExtra] = useState({ nontaxExport: 0 });
  useEffect(() => {
    repo.getTaxInterim(db, year).then(setInterim).catch(console.error);
    repo.getTaxReturnInput(db, year).then(setExtra).catch(console.error);
  }, [db, year, dataVersion]);
  return useMemo(() => {
    if (taxYear.status === "exempt" || !interim || !inv) return null;
    const base = buildTaxBase(lines, taxYears);
    const options = {
      businessClass: taxYear.business_class, interimNational: interim.national, interimLocal: interim.local, baseSales: baseSales?.base ?? null,
      deduction: taxYear.deduction, inventory: inv.adjust ?? null, nontaxExport: extra.nontaxExport,
    };
    const m = taxYear.status as ReturnMethod;
    return m === "twenty" ? twentyReturn(base, options, "一般用") : m === "thirty" ? thirtyReturn(base, options, "一般用") : computeReturn(m, base, options);
  }, [lines, taxYears, taxYear, interim, inv, baseSales, extra]);
};

/** 棚卸資産の調整（保存したもの）と、帳簿の期首・期末の棚卸高（読み込み中は null） */
export const useInventory = (lines: FlatLine[], opening: OpeningBalances) => {
  const { db, year, accounts, dataVersion } = useAppContext();
  const [adjust, setAdjust] = useState<InventoryAdjust | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    repo.getInventoryAdjust(db, year).then((v) => alive && setAdjust(v)).catch(console.error);
    return () => {
      alive = false;
    };
  }, [db, year, dataVersion]);
  const amounts = useMemo(() => {
    const end = closingBalances(accounts, opening, lines);
    return inventoryOf(accounts, (a) => opening[a.id] ?? 0, (a) => end.get(a.id) ?? 0);
  }, [accounts, opening, lines]);
  return useMemo(() => (adjust === undefined ? null : { adjust, ...amounts }), [adjust, amounts]);
};

const PCT_LABEL: Record<number, string> = { 100: "全額（インボイスあり）", 80: "80%（経過措置）", 70: "70%（経過措置）", 50: "50%（経過措置）", 30: "30%（経過措置）" };

/** 棚卸資産の調整（付表2-3 ⑯）の入力 */
const InventorySection = ({ inv, disabled }: { inv: NonNullable<ReturnType<typeof useInventory>>; disabled: boolean }) => {
  const { db, year, taxYears, taxYear, bump } = useAppContext();
  const toast = useToast();
  // 初めの向き：前年が免税（または年の途中から課税事業者）なら加算、翌年が免税なら減算
  const next = taxYearOf(taxYears, year + 1);
  const suggested: InventoryAdjust["direction"] = next.status === "exempt" && !next.inherited ? "sub" : "add";
  const saved: InventoryAdjust = inv.adjust ?? { direction: suggested, rows: [] };
  const [draft, setDraft] = useState<InventoryAdjust>(saved);
  useEffect(() => setDraft(saved), [inv.adjust]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);
  const tax = inventoryAdjustTax(draft);
  const setRow = (i: number, patch: Partial<InventoryAdjust["rows"][number]>) =>
    setDraft((d) => ({ ...d, rows: d.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const fromBooks = () => {
    const amount = draft.direction === "add" ? inv.opening : inv.closing;
    setDraft((d) => ({ ...d, rows: [{ rate: 10, pct: 100, amount }] }));
    toast(`帳簿の${draft.direction === "add" ? "期首" : "期末"}の棚卸高 ${yen(amount)} 円を、税率10%・全額として入れました（保存はまだです）。軽減税率の品物や経過措置の仕入れは分けてください`);
  };
  const saveIt = async () => {
    try {
      await repo.saveInventoryAdjust(db, year, draft);
      bump();
      toast("棚卸資産の調整を保存しました");
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };
  const prev = taxYearOf(taxYears, year - 1);
  return (
    <div className="tax-inventory">
      <h3 className="sheet-sub">棚卸資産の調整（本則課税の付表2-3 ⑯）</h3>
      <div className="field-row wrap">
        <label className="check"><input type="radio" name="inv-dir" checked={draft.direction === "add"} disabled={disabled} onChange={() => setDraft((d) => ({ ...d, direction: "add" }))} /> 加算（免税事業者から課税事業者になった年）</label>
        <label className="check"><input type="radio" name="inv-dir" checked={draft.direction === "sub"} disabled={disabled} onChange={() => setDraft((d) => ({ ...d, direction: "sub" }))} /> 減算（翌年から免税事業者になる年）</label>
      </div>
      {draft.rows.length > 0 && (
        <table className="ledger it-table tax-inventory-rows">
          <thead><tr><th style={{ width: 150 }}>税率</th><th style={{ width: 220 }}>控除できる割合</th><th className="num">取得価額（税込）</th><th style={{ width: 40 }} /></tr></thead>
          <tbody>
            {draft.rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <select className="input" value={r.rate} disabled={disabled} onChange={(e) => setRow(i, { rate: Number(e.target.value) as Rate })} aria-label="税率">
                    <option value={10}>10%（7.8/110）</option>
                    <option value={8}>8% 軽減（6.24/108）</option>
                  </select>
                </td>
                <td>
                  <select className="input" value={r.pct} disabled={disabled} onChange={(e) => setRow(i, { pct: Number(e.target.value) })} aria-label="控除できる割合">
                    {Object.entries(PCT_LABEL).sort((a, b) => Number(b[0]) - Number(a[0])).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </td>
                <td><AmountInput value={r.amount || null} onChange={(n) => setRow(i, { amount: n ?? 0 })} disabled={disabled} aria-label="取得価額" /></td>
                <td><button type="button" className="btn ghost sm icon" onClick={() => setDraft((d) => ({ ...d, rows: d.rows.filter((_, j) => j !== i) }))} disabled={disabled} aria-label="行を消す" title="行を消す"><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="field-row wrap tax-inventory-actions">
        <button type="button" className="btn ghost sm" onClick={() => setDraft((d) => ({ ...d, rows: [...d.rows, { rate: 10, pct: 100, amount: 0 }] }))} disabled={disabled}><Plus size={14} /> 行を足す</button>
        <button type="button" className="btn ghost sm" onClick={fromBooks} disabled={disabled || (draft.direction === "add" ? inv.opening : inv.closing) === 0}>
          <Wand2 size={14} /> 帳簿の{draft.direction === "add" ? "期首" : "期末"}の棚卸高から入れる（{yen(draft.direction === "add" ? inv.opening : inv.closing)}円）
        </button>
        <span className="tax-inventory-total">⑯ {signed(tax[8] + tax[10])} 円（6.24% 分 {signed(tax[8])}・7.8% 分 {signed(tax[10])}）</span>
        <button type="button" className="btn ghost" onClick={saveIt} disabled={disabled || !changed}><Save size={15} /> 保存する</button>
      </div>
      <p className="field-note">
        {draft.direction === "add"
          ? `${taxYear.taxable_from ? `${taxYear.taxable_from} から課税事業者なので、その前日` : `課税事業者になった日の前日（${year - 1}年12月31日）`}に持っていた棚卸資産のうち、免税事業者の期間に仕入れたものの取得価額（引取運賃などを含む）を入れます。`
          : `${year}年12月31日に持っている棚卸資産のうち、${year}年に仕入れたものの取得価額を入れます。`}
        適格請求書発行事業者でない相手から仕入れたものは、仕入れた時期の控除できる割合（令和8年9月までは80% など）を選びます。棚卸資産の明細（品名・数量・取得価額）を記録して保存することが要件です。
        調整の税額は ⑰ に加え、個別対応方式では課税売上げにのみ要するもの（⑲）に入れます。簡易課税・2割特例では使いません。
        {prev.status === "exempt" && draft.direction === "add" && !inv.adjust && ` ${year - 1}年は免税事業者でした。`}
      </p>
    </div>
  );
};

export const TaxReturnView = () => {
  const { db, year, settings, taxYears, taxYear, isClosed, can, dataVersion, bump, accounts, counterparties } = useAppContext();
  const { rawLines: lines, opening } = useYearData(); // 消費税は入れたとおりの明細（税込）から
  const inv = useInventory(lines, opening);
  // 還付申告に関する明細書（帳簿から作る候補と、仕入金額等の明細）
  const books = useMemo(
    () => ({ lines, accounts, counterparties, from: taxYear.taxable_from || `${year}-01-01`, to: `${year}-12-31` }),
    [lines, accounts, counterparties, taxYear.taxable_from, year],
  );
  const purchases = useMemo(() => purchaseFigures(books), [books]);
  const refund = useRefundDetail(books, () => refundDetailFromBooks(books));
  const toast = useToast();
  const available = methodsFor(year);
  const current = (taxYear.status === "exempt" ? null : taxYear.status) as ReturnMethod | null;
  const [method, setMethod] = useState<ReturnMethod>(current && available.includes(current) ? current : "standard");
  useEffect(() => {
    if (current && available.includes(current)) setMethod(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, year]);
  const [firstKind, setFirstKind] = useState<"一般用" | "簡易課税用">("一般用");

  // 中間納付税額
  const [interim, setInterim] = useState({ national: 0, local: 0 });
  const [draft, setDraft] = useState({ national: "", local: "" });
  const interimInfo = useInterim();
  useEffect(() => {
    repo.getTaxInterim(db, year).then((x) => {
      setInterim(x);
      setDraft({ national: String(x.national), local: String(x.local) });
    }).catch(console.error);
  }, [db, year, dataVersion]);
  // 非課税資産の輸出等の金額（本則課税の付表2-3 ③）
  const [nontaxExport, setNontaxExport] = useState(0);
  const [exportDraft, setExportDraft] = useState("");
  useEffect(() => {
    repo.getTaxReturnInput(db, year).then((x) => {
      setNontaxExport(x.nontaxExport);
      setExportDraft(String(x.nontaxExport));
    }).catch(console.error);
  }, [db, year, dataVersion]);
  const saveExport = async () => {
    try {
      await repo.saveNontaxExport(db, year, Number(exportDraft || 0));
      bump();
      toast("非課税資産の輸出等の金額を保存しました");
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };
  const saveInterim = async () => {
    try {
      await repo.saveTaxInterim(db, year, Number(draft.national || 0), Number(draft.local || 0));
      bump();
      toast("中間納付税額を保存しました");
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };

  // 簡易課税の事業区分は、明細に記録した区分（登録したときに 明細 → 科目の初期値 → 主な事業区分 で決まる。無ければ不明）
  const base = useMemo(() => buildTaxBase(lines, taxYears), [lines, taxYears]);
  const baseSales = useBaseSales();
  const options = {
    businessClass: taxYear.business_class, interimNational: interim.national, interimLocal: interim.local, baseSales: baseSales?.base ?? null, deduction: taxYear.deduction,
    inventory: inv?.adjust ?? null, nontaxExport,
  };
  const results = useMemo(
    () => available.map((m) => ({ m, r: computeReturn(m, base, options), problem: baseSales ? methodProblem(m, baseSales) : null })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, interim, taxYear.business_class, taxYear.deduction, year, baseSales, inv?.adjust, nontaxExport],
  );
  // 2割・3割特例の第一表は、簡易課税の届出があれば簡易課税用、無ければ一般用
  const shown = method === "twenty" ? twentyReturn(base, options, firstKind)
    : method === "thirty" ? thirtyReturn(base, options, firstKind)
      : results.find((x) => x.m === method)?.r ?? computeReturn(method, base, options);
  const forms = shown.forms;
  // 使えない方式は比べない
  const usable = results.filter((x) => !x.problem);
  const best = Math.min(...usable.map((x) => x.r.total));
  // どれも同じ額なら「いちばん有利」は出さない
  const showBest = new Set(usable.map((x) => x.r.total)).size > 1;
  const admin = can("settings");
  // ⑧ 控除不足還付税額（一般用）があれば、還付申告に関する明細書を付ける
  const shortfall = refundShortfall(shown);
  const needDetail = shortfall > 0 && !refund.saved;

  // e-Tax のデータ（.xtx）
  const filer = filerFromSettings(settings);
  const xtxBlocked = xtxProblem(shown, year);
  const missing = filerProblems(filer);
  // 個人番号は書き出すときに入れてもらう（保存しない）。公金受取口座で還付を受けるときは必須
  const [askNumber, setAskNumber] = useState(false);
  const publicRefund = shown.total < 0 && filer.refund?.kind === "public";
  const exportXtx = async (myNumber: string) => {
    setAskNumber(false);
    try {
      const xml = buildTaxXtx(shown, { ...filer, myNumber }, {
        from: taxYear.taxable_from || `${year}-01-01`, to: `${year}-12-31`, createdOn: todayIso(),
        refundDetail: shortfall > 0 && refund.saved ? { input: refund.saved, purchases } : undefined,
      });
      const path = await save({
        defaultPath: `消費税申告_${year}年分_${METHOD_LABEL[method]}.xtx`,
        filters: [{ name: "e-Tax のデータ", extensions: ["xtx"] }],
      });
      if (!path) return;
      await writeTextFile(path, xml);
      toast("e-Tax のデータを書き出しました");
    } catch (e) {
      toast(`書き出せませんでした：${String(e).replace(/^Error: /, "")}`, "error");
    }
  };

  return (
    <div className="tax-return">
      {askNumber && (
        <MyNumberDialog
          persons={[{ key: "self", label: settings.owner_name || "本人", required: publicRefund }]}
          note={publicRefund ? "公金受取口座で還付を受けるので、個人番号が要ります。" : "入れないと、個人番号の欄が空の申告書になります。"}
          onSubmit={(n) => exportXtx(n.self)} onClose={() => setAskNumber(false)}
        />
      )}
      <div className="tax-return-head print-skip">
        <h3 className="sheet-sub">方式の比較（{year}年）</h3>
        <table className="ledger tax-compare">
          <colgroup>
            <col style={{ width: "20%" }} /><col style={{ width: "13%" }} /><col style={{ width: "13%" }} /><col style={{ width: "16%" }} /><col />
          </colgroup>
          <thead>
            <tr><th>方式</th><th className="num">消費税</th><th className="num">地方消費税</th><th className="num">合計（納付・△還付）</th><th>使うための主な条件</th></tr>
          </thead>
          <tbody>
            {results.map(({ m, r, problem }) => (
              <tr key={m} className={`clickable${m === method ? " on" : ""}${problem ? " unusable" : ""}`} onClick={() => setMethod(m)}>
                <td>
                  {METHOD_LABEL[m]}
                  {m === current && <span className="badge badge-adjust">この年の設定</span>}
                  {!problem && showBest && r.total === best && <span className="tax-best">いちばん有利</span>}
                </td>
                <td className="num">{signed(r.national)}</td>
                <td className="num">{signed(r.local)}</td>
                <td className="num"><b>{signed(r.total)}</b></td>
                <td className="muted">
                  {problem && <span className="tax-unusable">{problem}。</span>}
                  {METHOD_NOTE[m]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="field-note">
          簡易課税は、売上の明細に記録した事業区分ごとに計算しています（区分の分からない売上は、その年の売上に出てくる区分のうち、みなし仕入率がいちばん低い区分）。
          基準期間（{year - 2}年）の課税売上高：
          {baseSales === null ? "読み込み中" : baseSales.base === null ? "分かりません（事業者設定の「消費税」で入れられます）" : `${yen(baseSales.base)}円（${baseSales.source === "manual" ? "手で入力" : "帳簿から計算"}）`}。
          税込経理・割戻し計算で、中間納付税額を差し引いた額です。課税区分は事業者設定の「消費税」で決めます（ここで選んだ方式は表示だけです）。
        </p>

        <form className="field-row tax-interim" onSubmit={(e) => { e.preventDefault(); saveInterim(); }}>
          <label className="field">
            <span>中間納付税額（消費税）</span>
            <input className="input num" inputMode="numeric" value={draft.national} onChange={(e) => setDraft((d) => ({ ...d, national: e.target.value.replace(/[^\d]/g, "") }))} disabled={!admin || isClosed} />
          </label>
          <label className="field">
            <span>中間納付譲渡割額（地方消費税）</span>
            <input className="input num" inputMode="numeric" value={draft.local} onChange={(e) => setDraft((d) => ({ ...d, local: e.target.value.replace(/[^\d]/g, "") }))} disabled={!admin || isClosed} />
          </label>
          <div style={{ alignSelf: "flex-end", display: "flex", gap: 8 }}>
            <button className="btn ghost" type="submit" disabled={!admin || isClosed || (String(interim.national) === draft.national && String(interim.local) === draft.local)}>
              <Save size={15} /> 保存する
            </button>
            {interimInfo && <InterimFillButton info={interimInfo} />}
          </div>
          <p className="field-note">
            納付した額ではなく、中間申告書に書いた「納付すべき税額」の合計です。
            {interimInfo && interimInfo.plan.periods.length > 0 && `前年の実績で計算した額は、消費税 ${yen(interimInfo.plan.national)}円・地方消費税 ${yen(interimInfo.plan.local)}円です（「中間申告」で回数と期限を見られます）。`}
          </p>
        </form>
        {method === "standard" && (
          <form className="field-row tax-interim" onSubmit={(e) => { e.preventDefault(); saveExport(); }}>
            <label className="field">
              <span>③ 非課税資産の輸出等の金額（あれば）</span>
              <input className="input num" inputMode="numeric" value={exportDraft} onChange={(e) => setExportDraft(e.target.value.replace(/[^\d]/g, ""))} disabled={!admin || isClosed} />
            </label>
            <div style={{ alignSelf: "flex-end" }}>
              <button className="btn ghost" type="submit" disabled={!admin || isClosed || String(nontaxExport) === exportDraft}><Save size={15} /> 保存する</button>
            </div>
            <p className="field-note">国外の相手への貸付金の利子など、非課税の資産を輸出した額と、海外支店などへ移した資産の額です（付表2-3 ③。課税売上割合の計算に入ります）。</p>
          </form>
        )}
        {method === "standard" && inv && <InventorySection inv={inv} disabled={!admin || isClosed} />}
      </div>

      <div className="tax-return-forms print-area">
        <div className="tax-return-title">
          <h3>{year}年分 消費税及び地方消費税の申告書の数字（{METHOD_LABEL[method]}）</h3>
          {(method === "twenty" || method === "thirty") && (
            <select className="input sm print-skip" value={firstKind} onChange={(e) => setFirstKind(e.target.value as typeof firstKind)} aria-label="第一表の種類" style={{ width: "auto" }}>
              <option value="一般用">第一表は一般用（簡易課税の届出なし）</option>
              <option value="簡易課税用">第一表は簡易課税用（簡易課税の届出あり）</option>
            </select>
          )}
          <button className="btn ghost sm print-skip" onClick={() => window.print()}><Printer size={14} /> 印刷</button>
          <button className="btn primary sm print-skip" onClick={() => setAskNumber(true)} disabled={!!xtxBlocked || missing.length > 0 || needDetail}>
            <FileDown size={14} /> e-Tax 用に書き出す
          </button>
        </div>
        <div className="tax-xtx print-skip">
          {xtxBlocked ? (
            <span>{xtxBlocked}。</span>
          ) : missing.length > 0 ? (
            <span>e-Tax 用に書き出すには、事業者設定で次のものを入れてください：{missing.join("、")}。</span>
          ) : needDetail ? (
            <span>還付申告になるので、下の「消費税の還付申告に関する明細書」を確かめて保存してください。保存すると、e-Tax 用のデータに明細書も入れて書き出せます。</span>
          ) : (
            <span>
              e-Tax 用のデータ（.xtx）は、e-Taxソフト（WEB版）の「作成済みデータの利用」で読み込み、内容を確かめて送信します。個人番号は書き出すときに入れます。
              {shown.total < 0 && (filer.refund ? "還付になるので、事業者設定の還付先も書きます。" : "還付になりますが、事業者設定に還付先が入っていません。")}
              {shortfall > 0 && "還付申告に関する明細書も入れます。"}
              {current && method !== current && <b> この年の設定（{METHOD_LABEL[current]}）とは違う方式です。</b>}
              {xtxVersionFor(year).fallback && (
                <b> 令和{year - 2018}年分の e-Tax の版はまだ domble に入っていないため、いちばん新しい版（{xtxVersionFor(year).version}）で書き出します。e-Tax で読み込めないときは、ソフトの更新を待ってください。</b>
              )}
            </span>
          )}
        </div>
        {shown.deduction && (
          <div className="tax-xtx print-skip">
            控除する課税仕入れ等の税額：個別対応方式 <b>{yen(shown.deduction.amounts.individual)}円</b>・一括比例配分方式 <b>{yen(shown.deduction.amounts.lump)}円</b>
            {shown.deduction.amounts.individual !== shown.deduction.amounts.lump && (
              <>（{shown.deduction.amounts.individual > shown.deduction.amounts.lump ? "個別対応方式" : "一括比例配分方式"}が有利）</>
            )}。
            今は{shown.deduction.method === "individual" ? "個別対応方式" : "一括比例配分方式"}で計算しています（事業者設定の「消費税」の控除の方式。一括比例配分方式は2年続けて使う決まり）。
          </div>
        )}
        {shown.notes.length > 0 && (
          <ul className="tax-return-notes">{shown.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        )}
        {shortfall > 0 && (
          <p className="notice">
            還付申告（⑧ 控除不足還付税額 {yen(shortfall)}円）になるので、「消費税の還付申告に関する明細書（個人事業者用）」を添付します（消費税法施行規則22条3項）。下の明細書を確かめて保存してください。
          </p>
        )}
        {forms.map((f) => <FormTable key={f.id} form={f} />)}
        {shortfall > 0 && refund.draft && (
          <RefundDetailSection draft={refund.draft} setDraft={refund.setDraft} saved={refund.saved} books={books} purchases={purchases} disabled={!admin || isClosed} />
        )}
        <p className="field-note">
          確定申告書等作成コーナーや e-Tax に書き写すときの数字です。e-Tax 用のデータに書き出すこともできます（送信は e-Tax で行います）。
          申告の前に、集計表と「確認」の内容を確かめてください。
        </p>
      </div>
    </div>
  );
};

const FormTable = ({ form }: { form: TaxForm }) => (
  <section className="tax-form-block">
    <h4>{form.title}</h4>
    <table className="ledger tax-form-table">
      <colgroup>
        <col style={{ width: 52 }} />
        <col />
        {form.abc && <><col style={{ width: 130 }} /><col style={{ width: 130 }} /></>}
        <col style={{ width: 140 }} />
        <col style={{ width: "22%" }} />
      </colgroup>
      <thead>
        <tr>
          <th>欄</th><th>項目</th>
          {form.abc && <><th className="num">6.24% 適用分 A</th><th className="num">7.8% 適用分 B</th></>}
          <th className="num">{form.abc ? "合計 C" : "金額"}</th><th>備考</th>
        </tr>
      </thead>
      <tbody>
        {form.rows.map((r, i) => (
          <tr key={`${r.no}-${i}`}>
            <td className="tax-form-no">{r.no}</td>
            <td>{r.label}</td>
            {form.abc && <><td className="num">{r.a === undefined ? "" : yen(r.a)}</td><td className="num">{r.b === undefined ? "" : yen(r.b)}</td></>}
            <td className="num"><b>{r.c === null ? "" : signed(r.c)}</b></td>
            <td className="muted">{r.note ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </section>
);
