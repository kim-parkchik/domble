/**
 * 消費税の還付申告に関する明細書（個人事業者用）
 *  一般用の申告で ⑧ 控除不足還付税額があるときに、申告書の数字の下に出す（作り方は lib/taxRefundDetail.ts）
 *  - 保存したものが無ければ、帳簿から作った候補を出す（保存するまで e-Tax 用には書き出さない）
 *  - 3(1) 仕入金額等の明細は帳簿から計算するだけ（入力しない）
 */
import { useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2, Wand2 } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import { AmountInput, FullDateInput } from "../../components/Inputs";
import { yen } from "../../lib/format";
import * as repo from "../../db/repo";
import {
  BANK_KINDS, BRANCH_KINDS, DEPOSIT_KINDS, REFUND_DETAIL_LIMITS as L, REFUND_DETAIL_ROWS, refundCandidates, refundDetailProblems,
  type PurchaseFigure, type PurchaseFigures, type RefundExportRow, type RefundTradeRow, type TaxRefundDetailInput,
} from "../../lib/taxRefundDetail";

type TradeKey = "sales" | "inventory" | "assets";
const EMPTY_TRADE: RefundTradeRow = { kind: "", date: "", continuous: false, amount: 0, regNo: "", name: "", address: "" };
const EMPTY_EXPORT: RefundExportRow = { name: "", address: "", amount: 0, goods: "", customs: "" };

export const RefundDetailSection = ({ draft, setDraft, saved, books, purchases, disabled }: {
  draft: TaxRefundDetailInput;
  setDraft: (f: (d: TaxRefundDetailInput) => TaxRefundDetailInput) => void;
  /** 保存したもの（無ければ null） */
  saved: TaxRefundDetailInput | null;
  books: Parameters<typeof refundCandidates>[0];
  purchases: PurchaseFigures;
  disabled: boolean;
}) => {
  const { db, year, bump } = useAppContext();
  const toast = useToast();
  const problems = refundDetailProblems(draft);
  const changed = saved === null || JSON.stringify(saved) !== JSON.stringify(draft);

  const setTrade = (key: TradeKey, i: number, patch: Partial<RefundTradeRow>) =>
    setDraft((d) => ({ ...d, [key]: d[key].map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const setExport = (i: number, patch: Partial<RefundExportRow>) =>
    setDraft((d) => ({ ...d, exports: d.exports.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const fromBooks = () => {
    const c = refundCandidates(books);
    setDraft((d) => ({ ...d, sales: c.sales, exports: c.exports, inventory: c.inventory, assets: c.assets, reasons: { ...c.reasons, otherText: d.reasons.otherText } }));
    toast("帳簿から明細の行と理由を作り直しました（保存はまだです）。住所・資産の種類などを確かめてください");
  };
  const saveIt = async () => {
    try {
      await repo.saveRefundDetail(db, year, draft);
      bump();
      toast("還付申告に関する明細書を保存しました");
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };

  const tradeTable = (key: TradeKey, title: string, o: { continuous: boolean; regNo: boolean; kindLimit: number; dateLabel: string; note: string }) => (
    <div className="refund-block">
      <h5>{title}</h5>
      <p className="field-note print-skip">{o.note}</p>
      {draft[key].length > 0 && (
        <table className="ledger it-table refund-rows">
          <thead>
            <tr>
              <th style={{ width: "15%" }}>資産の種類等</th><th style={{ width: 150 }}>{o.dateLabel}</th><th className="num" style={{ width: 130 }}>取引金額等（税込）</th>
              {o.regNo && <th style={{ width: 130 }}>登録番号（T の後）</th>}<th>取引先の氏名（名称）</th><th>取引先の住所（所在地）</th><th className="print-skip" style={{ width: 36 }} />
            </tr>
          </thead>
          <tbody>
            {draft[key].map((r, i) => (
              <tr key={i}>
                <td><input className="input" value={r.kind} maxLength={o.kindLimit} disabled={disabled} onChange={(e) => setTrade(key, i, { kind: e.target.value })} aria-label="資産の種類等" /></td>
                <td>
                  {r.continuous ? <span className="refund-cont">継続</span> : <FullDateInput value={r.date} onChange={(v) => setTrade(key, i, { date: v })} year={year} aria-label={o.dateLabel} disabled={disabled} />}
                  {o.continuous && (
                    <label className="check print-skip"><input type="checkbox" checked={r.continuous} disabled={disabled} onChange={(e) => setTrade(key, i, { continuous: e.target.checked, date: "" })} /> 継続</label>
                  )}
                </td>
                <td><AmountInput value={r.amount || null} onChange={(v) => setTrade(key, i, { amount: v ?? 0 })} disabled={disabled} aria-label="取引金額等" /></td>
                {o.regNo && <td><input className="input" value={r.regNo} maxLength={13} inputMode="numeric" disabled={disabled} onChange={(e) => setTrade(key, i, { regNo: e.target.value.replace(/\D/g, "") })} aria-label="登録番号" /></td>}
                <td><input className="input" value={r.name} maxLength={L.partnerName} disabled={disabled} onChange={(e) => setTrade(key, i, { name: e.target.value })} aria-label="取引先の氏名" /></td>
                <td><input className="input" value={r.address} maxLength={L.partnerAddress} disabled={disabled} onChange={(e) => setTrade(key, i, { address: e.target.value })} aria-label="取引先の住所" /></td>
                <td className="print-skip">
                  <button type="button" className="btn ghost sm icon" disabled={disabled} onClick={() => setDraft((d) => ({ ...d, [key]: d[key].filter((_, j) => j !== i) }))} aria-label="行を消す" title="行を消す"><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {draft[key].length === 0 && <p className="muted refund-none">該当なし</p>}
      {draft[key].length < REFUND_DETAIL_ROWS && (
        <button type="button" className="btn ghost sm print-skip" disabled={disabled} onClick={() => setDraft((d) => ({ ...d, [key]: [...d[key], { ...EMPTY_TRADE }] }))}><Plus size={14} /> 行を足す</button>
      )}
    </div>
  );

  const purchaseRow = (label: string, f: PurchaseFigure, strong = false) => (
    <tr className={strong ? "st-strong" : ""}>
      <td>{label}</td><td className="num">{yen(f.total)}</td><td className="num">{yen(f.notTaxable)}</td><td className="num">{yen(f.taxable)}</td>
    </tr>
  );
  const re = purchases.realEstate.subtotal;

  return (
    <section className="tax-form-block refund-detail">
      <h4>消費税の還付申告に関する明細書（個人事業者用）</h4>
      {saved === null && <p className="notice print-skip">帳簿から作った候補です。確かめて直してから「保存する」を押してください（保存するまで e-Tax 用のデータには書き出せません）。</p>}

      <div className="refund-block">
        <h5>1 還付申告となった主な理由</h5>
        <div className="field-row wrap">
          <label className="check"><input type="checkbox" checked={draft.reasons.export} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, reasons: { ...d.reasons, export: e.target.checked } }))} /> 輸出等の免税取引の割合が高い</label>
          <label className="check"><input type="checkbox" checked={draft.reasons.capex} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, reasons: { ...d.reasons, capex: e.target.checked } }))} /> 設備投資（高額な固定資産の購入）</label>
          <label className="check"><input type="checkbox" checked={draft.reasons.other} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, reasons: { ...d.reasons, other: e.target.checked } }))} /> その他</label>
        </div>
        {draft.reasons.other && (
          <input className="input" value={draft.reasons.otherText} maxLength={L.otherReason} disabled={disabled} placeholder="例：期末に多額の棚卸資産を購入したため。"
            onChange={(e) => setDraft((d) => ({ ...d, reasons: { ...d.reasons, otherText: e.target.value } }))} aria-label="その他の理由" />
        )}
      </div>

      <h5 className="refund-part">2 課税売上げ等に係る事項</h5>
      {tradeTable("sales", "(1) 主な課税資産の譲渡等", {
        continuous: true, regNo: false, kindLimit: L.saleKind, dateLabel: "譲渡年月日等",
        note: "輸出取引等の免税取引を除く課税売上のうち、取引金額（税抜）が100万円以上のものを上位5件。同じ取引先に続けて売っているものは、その年の合計を「継続」として書きます。資産の種類等には、売ったものの内容（例：機械用部品、事務所貸付け、対価の返還、貸倒れ）を書きます。",
      })}
      <div className="refund-block">
        <h5>(2) 主な輸出取引等の明細</h5>
        <p className="field-note print-skip">輸出免税の売上を、取引先ごとの合計の上位5件。所轄税関（支署）名は、主に使うものを書きます。</p>
        {draft.exports.length > 0 ? (
          <table className="ledger it-table refund-rows">
            <thead><tr><th>取引先の氏名（名称）</th><th>取引先の住所（所在地）</th><th className="num" style={{ width: 130 }}>取引金額</th><th>主な取引商品等</th><th style={{ width: 130 }}>所轄税関（支署）名</th><th className="print-skip" style={{ width: 36 }} /></tr></thead>
            <tbody>
              {draft.exports.map((r, i) => (
                <tr key={i}>
                  <td><input className="input" value={r.name} disabled={disabled} onChange={(e) => setExport(i, { name: e.target.value })} aria-label="取引先の氏名" /></td>
                  <td><input className="input" value={r.address} disabled={disabled} onChange={(e) => setExport(i, { address: e.target.value })} aria-label="取引先の住所" /></td>
                  <td><AmountInput value={r.amount || null} onChange={(v) => setExport(i, { amount: v ?? 0 })} disabled={disabled} aria-label="取引金額" /></td>
                  <td><input className="input" value={r.goods} maxLength={L.goods} disabled={disabled} onChange={(e) => setExport(i, { goods: e.target.value })} aria-label="主な取引商品等" /></td>
                  <td><input className="input" value={r.customs} maxLength={L.customs} disabled={disabled} onChange={(e) => setExport(i, { customs: e.target.value })} aria-label="所轄税関名" /></td>
                  <td className="print-skip"><button type="button" className="btn ghost sm icon" disabled={disabled} onClick={() => setDraft((d) => ({ ...d, exports: d.exports.filter((_, j) => j !== i) }))} aria-label="行を消す" title="行を消す"><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted refund-none">該当なし</p>}
        {draft.exports.length < REFUND_DETAIL_ROWS && (
          <button type="button" className="btn ghost sm print-skip" disabled={disabled} onClick={() => setDraft((d) => ({ ...d, exports: [...d.exports, { ...EMPTY_EXPORT }] }))}><Plus size={14} /> 行を足す</button>
        )}
        {(draft.exports.length > 0 || draft.bank.name || draft.broker.name) && (
          <div className="refund-export-more">
            <div className="field-row wrap">
              <label className="field"><span>輸出取引等に利用する主な金融機関</span><input className="input" value={draft.bank.name} maxLength={L.bankName} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, bank: { ...d.bank, name: e.target.value } }))} /></label>
              <label className="field"><span>区分</span><select className="input" value={draft.bank.kind} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, bank: { ...d.bank, kind: Number(e.target.value) } }))}>{BANK_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label className="field"><span>支店名</span><input className="input" value={draft.bank.branch} maxLength={L.branchName} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, bank: { ...d.bank, branch: e.target.value } }))} /></label>
              <label className="field"><span>本支店区分</span><select className="input" value={draft.bank.branchKind} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, bank: { ...d.bank, branchKind: Number(e.target.value) } }))}>{BRANCH_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label className="field"><span>預金種類</span><select className="input" value={draft.bank.deposit} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, bank: { ...d.bank, deposit: Number(e.target.value) } }))}>{DEPOSIT_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label className="field"><span>口座番号</span><input className="input" value={draft.bank.number} maxLength={L.accountNo} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, bank: { ...d.bank, number: e.target.value.replace(/[^\d-]/g, "") } }))} /></label>
            </div>
            <div className="field-row wrap">
              <label className="field"><span>輸出取引等に利用する主な通関業者</span><input className="input" value={draft.broker.name} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, broker: { ...d.broker, name: e.target.value } }))} /></label>
              <label className="field"><span>通関業者の住所（所在地）</span><input className="input" value={draft.broker.address} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, broker: { ...d.broker, address: e.target.value } }))} /></label>
            </div>
          </div>
        )}
      </div>

      <h5 className="refund-part">3 課税仕入れに係る事項</h5>
      <div className="refund-block">
        <h5>(1) 仕入金額等の明細（税込。帳簿から計算）</h5>
        <table className="ledger refund-purchase">
          <thead><tr><th>区分</th><th className="num">(イ) 決算額</th><th className="num">(ロ) (イ)のうち課税仕入れにならないもの</th><th className="num">(イ)−(ロ) 課税仕入高</th></tr></thead>
          <tbody>
            <tr className="cat-row"><td colSpan={4}>事業所得</td></tr>
            {purchaseRow("仕入金額", purchases.business.purchase)}
            {purchaseRow("必要経費", purchases.business.expense)}
            {purchaseRow("固定資産等の取得価額", purchases.business.asset)}
            {purchaseRow("小計", purchases.business.subtotal, true)}
            {(re.total !== 0 || re.taxable !== 0) && (
              <>
                <tr className="cat-row"><td colSpan={4}>不動産所得</td></tr>
                {purchaseRow("必要経費", purchases.realEstate.expense)}
                {purchaseRow("固定資産等の取得価額", purchases.realEstate.asset)}
                {purchaseRow("小計", re, true)}
              </>
            )}
            <tr className="st-strong"><td>課税仕入高の合計額</td><td /><td /><td className="num">{yen(purchases.taxableTotal)}</td></tr>
          </tbody>
        </table>
        <p className="field-note">
          決算額は決算書の科目から（仕入金額は期首・期末の棚卸高を除く仕入の科目、必要経費は経費の合計、固定資産等は固定資産の科目への取得）、課税仕入高は税区分が課税仕入の明細から計算します（家事分の振替・返品は差し引く）。
          固定資産等は事業所得に入れます（事業所得の無い年だけ不動産所得）。課税仕入れ等の税額の合計額は、付表2-3 ⑰ の金額を書きます。
          {purchases.outside !== 0 && <b> 仕入・経費・固定資産のほかの科目にも課税仕入の税区分があります（{yen(purchases.outside)}円）。税区分を確かめてください。</b>}
        </p>
      </div>
      {tradeTable("inventory", "(2) 主な棚卸資産・原材料等の取得", {
        continuous: true, regNo: true, kindLimit: L.inventoryKind, dateLabel: "取得年月日等",
        note: "固定資産を除く課税仕入のうち、取引金額（税抜）が100万円以上のものを上位5件。同じ取引先から続けて仕入れているものは、その年の合計を「継続」として書きます。資産の種類等には、内容（例：製品原料、加工委託、支払手数料）を書きます。登録番号を書けば、取引先の氏名・住所は省略できます。",
      })}
      {tradeTable("assets", "(3) 主な固定資産等の取得", {
        continuous: false, regNo: true, kindLimit: L.assetKind, dateLabel: "取得年月日等",
        note: "固定資産の科目への課税仕入のうち、1件あたりの取引金額（税抜）が100万円以上のものを上位5件。資産の種類等には、資産の種類（例：建物、車両。店舗の改装を含む）を書きます。",
      })}

      <div className="refund-block">
        <h5>4 {year}年中の特殊事情</h5>
        <textarea className="input" rows={2} value={draft.special} maxLength={L.special} disabled={disabled} placeholder="例：多額の売上対価の返還等が発生した。多額の貸倒損失が発生した。"
          onChange={(e) => setDraft((d) => ({ ...d, special: e.target.value }))} aria-label="特殊事情" />
      </div>

      {problems.length > 0 && <ul className="tax-return-notes print-skip">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <div className="field-row wrap print-skip refund-actions">
        <button type="button" className="btn ghost sm" onClick={fromBooks} disabled={disabled}><Wand2 size={14} /> 帳簿から作り直す</button>
        <button type="button" className="btn ghost" onClick={saveIt} disabled={disabled || !changed || problems.length > 0}><Save size={15} /> 保存する</button>
        {saved !== null && changed && <span className="muted">保存していない変更があります</span>}
      </div>
    </section>
  );
};

/** 明細書の入力（保存したもの・下書き）と、帳簿から作るもの */
export const useRefundDetail = (books: Parameters<typeof refundCandidates>[0], fromBooks: () => TaxRefundDetailInput) => {
  const { db, year, dataVersion } = useAppContext();
  const [saved, setSaved] = useState<TaxRefundDetailInput | null | undefined>(undefined);
  const [draft, setDraft] = useState<TaxRefundDetailInput | null>(null);
  useEffect(() => {
    let alive = true;
    repo.getRefundDetail(db, year).then((v) => {
      if (!alive) return;
      setSaved(v);
      setDraft(v ?? null);
    }).catch(console.error);
    return () => {
      alive = false;
    };
  }, [db, year, dataVersion]);
  // 保存したものが無ければ、帳簿の候補を下書きにする（帳簿が読み込まれてから）
  const shownDraft = useMemo(() => draft ?? (saved === null ? fromBooks() : null), [draft, saved, books]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (f: (d: TaxRefundDetailInput) => TaxRefundDetailInput) => setDraft((d) => f(d ?? shownDraft!));
  return { saved: saved ?? null, loaded: saved !== undefined, draft: shownDraft, setDraft: update };
};
