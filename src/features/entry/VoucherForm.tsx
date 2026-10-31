/**
 * 振替伝票（複合仕訳も入力できる汎用フォーム）
 * 新規入力ページと、各帳簿からの修正モーダルの両方で使います。
 */
import { useState, type KeyboardEvent } from "react";
import { Plus, Trash2, Save, X, Lock, FileStack, BookmarkPlus } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext, useInputDays } from "../../context/AppContext";
import { CounterpartyField, AccountWithSub, AmountInput, DateInput, MemoInput, TaxAmountField, TaxSelect } from "../../components/Inputs";
import { checkVoucher, emptyRow, rowsToLines, yearEnd } from "../../lib/accounting";
import { enterToNext, isComposing } from "../../lib/keyboard";
import { shortDate, todayIso, yen } from "../../lib/format";
import { inputDelayDays, isLateInput } from "../../lib/inputPeriod";
import type { VoucherRow } from "../../lib/types";
import * as repo from "../../db/repo";
import { useToast } from "../../components/Toast";
import { applyTemplate, type JournalTemplate } from "../../lib/templates";
import { usableSide, voucherFill } from "../../lib/memoFill";
import { TemplatePickModal, TemplateSaveModal } from "./TemplateModals";
import { entryRateOf, splitLinesByHomeUse } from "../../lib/homeUse";
import { CODE } from "../../constants/accounts";

interface Props {
  entryId?: number;
  initialDate: string;
  initialRows?: VoucherRow[];
  initialCounterpartyId?: number | null;
  /** 決算整理仕訳か（訂正のとき） */
  initialAdjustment?: boolean;
  onSaved?: (date: string) => void;
  onDeleted?: () => void;
  onCancel?: () => void;
}

const MIN_ROWS = 4;
const padRows = (rows: VoucherRow[]) => {
  const out = [...rows];
  while (out.length < MIN_ROWS) out.push(emptyRow());
  return out;
};

export const VoucherForm = ({ entryId, initialDate, initialRows, initialCounterpartyId = null, initialAdjustment = false, onSaved, onDeleted, onCancel }: Props) => {
  const { db, year, bump, strict, isDateClosed, accounts, subAccounts, counterparties, homeUseRates, labelOf } = useAppContext();
  const toast = useToast();
  const [date, setDate] = useState(initialDate);
  const [rows, setRows] = useState<VoucherRow[]>(padRows(initialRows ?? []));
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState("");
  const [counterpartyId, setCounterpartyId] = useState<number | null>(initialCounterpartyId);
  const [cpUnknown, setCpUnknown] = useState(false);
  /** 決算整理仕訳（日付は年度末に固定） */
  const [adjustment, setAdjustment] = useState(initialAdjustment);
  const toggleAdjustment = (on: boolean) => {
    setAdjustment(on);
    if (on) setDate(yearEnd(Number(date.slice(0, 4)) || year));
  };

  // 定型仕訳（新しく入力するときだけ）
  const [picking, setPicking] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const hasInput = rows.some((r) => r.debitAccountId || r.creditAccountId || r.debitAmount || r.creditAmount || r.memo.trim());
  const pickTemplate = async (t: JournalTemplate) => {
    if (hasInput && !(await ask("今の入力を消して、定型仕訳を入れます。", { title: "定型仕訳の呼び出し", okLabel: "入れる", cancelLabel: "やめる" }))) return;
    const r = applyTemplate(t.rows, accounts, subAccounts);
    setRows(padRows(r.rows));
    const cp = t.counterparty_id ? counterparties.find((c) => c.id === t.counterparty_id && c.is_active) : null;
    setCounterpartyId(cp ? cp.id : null);
    setPicking(false);
    if (r.dropped > 0) toast(`消された科目・補助科目が ${r.dropped} か所あったため、外して入れました`, "error");
    else toast(`「${t.name}」を入れました`);
  };

  // 締めた月（年の締めならその年度全体）の仕訳は、登録・訂正・削除できない（訂正で締めた月へ動かすのも不可）
  const locked = isDateClosed(date) || (!!entryId && isDateClosed(initialDate));
  // 入力期間を過ぎた日付の仕訳を新しく登録するとき（厳密モード）は、遅れた理由を履歴に残せる
  const inputDays = useInputDays();
  const late = strict && !entryId && inputDays != null && isLateInput(date, todayIso(), inputDays);

  // 家事按分（入力のたびに分ける科目）：新しく入力するときだけ、登録時に事業分と事業主貸に分ける。
  // 訂正のときは分けない（帳簿入力などで分け済みの仕訳を、もう一度分けてしまわないため）
  const [noSplit, setNoSplit] = useState(false);
  const drawId = accounts.find((a) => a.code === CODE.OWNER_DRAW)?.id;
  const homeUse = !entryId && drawId ? splitLinesByHomeUse(rowsToLines(rows), entryRateOf(homeUseRates, accounts), drawId) : null;

  const check = checkVoucher(rows);
  const diff = check.debitTotal - check.creditTotal;

  // 摘要からの自動入力：科目が両側とも空の行に、同じ摘要のいちばん新しい仕訳の同じ行の科目（補助科目・税区分）と、空なら取引先を入れる。金額は入れない
  const fillFromMemo = async (i: number, m: string) => {
    if (!m.trim() || rows[i]?.debitAccountId || rows[i]?.creditAccountId) return;
    const e = await repo.findMemoEntry(db, m).catch(() => null);
    const f = e ? voucherFill(e, m) : null;
    if (!e || !f) return;
    const d = usableSide(f.debit, accounts, subAccounts);
    const c = usableSide(f.credit, accounts, subAccounts);
    const patch: Partial<VoucherRow> = {
      ...(d ? { debitAccountId: d.accountId, debitSubId: d.subId, debitTax: d.tax, debitInvoice: d.invoice, debitClass: d.cls, debitUse: d.use } : {}),
      ...(c ? { creditAccountId: c.accountId, creditSubId: c.subId, creditTax: c.tax, creditInvoice: c.invoice, creditClass: c.cls, creditUse: c.use } : {}),
    };
    const filled: string[] = [];
    if (d || c) {
      // update は科目を変えると補助科目・税区分を初期値に戻すので、ここでは直接入れる（その間に科目を入れた行はそのまま）
      setRows((rs) => rs.map((r, j) => (j === i && !r.debitAccountId && !r.creditAccountId ? { ...r, ...patch } : r)));
      filled.push("科目");
    }
    const cp = !counterpartyId && e.counterparty_id ? counterparties.find((x) => x.id === e.counterparty_id && x.is_active) : null;
    if (cp) {
      setCounterpartyId(cp.id);
      filled.push("取引先");
    }
    if (filled.length) toast(`前の「${m.trim()}」（${shortDate(e.date)}・No.${e.id}）から、${filled.join("・")}を入れました`);
  };

  const update = (i: number, patch: Partial<VoucherRow>) =>
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r));
      // 科目を変えたら補助科目は選び直し、税区分はその科目の初期値に戻す
      if ("debitAccountId" in patch && patch.debitAccountId !== rs[i].debitAccountId) {
        next[i] = { ...next[i], debitSubId: null, debitTax: null, debitInvoice: null, debitClass: null, debitUse: null, debitTaxAmount: null };
      }
      if ("creditAccountId" in patch && patch.creditAccountId !== rs[i].creditAccountId) {
        next[i] = { ...next[i], creditSubId: null, creditTax: null, creditInvoice: null, creditClass: null, creditUse: null, creditTaxAmount: null };
      }
      // 金額・税区分を変えたら、手で直した消費税額は自動に戻す
      if (("debitAmount" in patch && patch.debitAmount !== rs[i].debitAmount) || ("debitTax" in patch && patch.debitTax !== rs[i].debitTax) || ("debitInvoice" in patch && patch.debitInvoice !== rs[i].debitInvoice)) {
        if (!("debitTaxAmount" in patch)) next[i] = { ...next[i], debitTaxAmount: null };
      }
      if (("creditAmount" in patch && patch.creditAmount !== rs[i].creditAmount) || ("creditTax" in patch && patch.creditTax !== rs[i].creditTax) || ("creditInvoice" in patch && patch.creditInvoice !== rs[i].creditInvoice)) {
        if (!("creditTaxAmount" in patch)) next[i] = { ...next[i], creditTaxAmount: null };
      }
      // 1行だけの仕訳のときは、借方金額を貸方にも写す（貸方が空 or 同額だった場合）
      if ("debitAmount" in patch) {
        const before = rs[i];
        const othersEmpty = rs.every((r, j) => j === i || (!r.debitAccountId && !r.debitAmount && !r.creditAccountId && !r.creditAmount));
        if (othersEmpty && (before.creditAmount == null || before.creditAmount === before.debitAmount)) {
          next[i].creditAmount = patch.debitAmount ?? null;
        }
      }
      // 最終行に入力が始まったら1行足す
      const last = next[next.length - 1];
      if (last.debitAccountId || last.creditAccountId || last.debitAmount || last.creditAmount) next.push(emptyRow());
      return next;
    });

  const removeRow = (i: number) => setRows((rs) => padRows(rs.filter((_, j) => j !== i)));

  /** 日付の欄に読めない日付が入っているか（そのままだと前の日付で登録されるので止める） */
  const [dateBad, setDateBad] = useState(false);
  const submit = async () => {
    if (locked) return;
    const c = checkVoucher(rows);
    const errs = [...c.errors];
    if (dateBad && !adjustment) errs.unshift(`日付が正しくありません（${year}年の日付を入れてください）`);
    if (cpUnknown) errs.push("取引先が一覧にありません。「取引先に追加」で登録するか、欄を空にしてください");
    if (errs.length) {
      setErrors(errs);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      const lines = homeUse && !noSplit ? homeUse.lines : rowsToLines(rows);
      if (entryId) await repo.updateEntry(db, entryId, date, lines, reason, counterpartyId, adjustment);
      else await repo.createEntry(db, date, lines, counterpartyId, late ? reason : "", adjustment);
      bump();
      toast(entryId ? "仕訳を更新しました" : "仕訳を登録しました");
      if (!entryId) {
        setRows(padRows([]));
        setReason("");
      }
      onSaved?.(date);
    } catch (e) {
      console.error(e);
      toast(`保存できませんでした：${String(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!entryId || locked) return;
    const ok = await ask(
      strict
        ? "この仕訳を削除します。帳簿や集計からは外れますが、削除した事実と内容は「訂正・削除履歴」に残ります。"
        : "この仕訳を削除します。元に戻せません。",
      { title: "仕訳の削除", kind: "warning", okLabel: "削除", cancelLabel: "やめる" },
    );
    if (!ok) return;
    try {
      await repo.deleteEntry(db, entryId, reason);
    } catch (e) {
      toast(`削除できませんでした：${String(e)}`, "error");
      return;
    }
    bump();
    toast("仕訳を削除しました");
    onDeleted?.();
  };

  // ⌘/Ctrl + Enter でどこからでも登録
  const onFormKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !isComposing(e)) {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
      setTimeout(submit, 0);
    }
  };
  const nav = enterToNext(submit);

  return (
    <div className="voucher" data-navgroup onKeyDown={onFormKey}>
      <div className="voucher-top">
        <label className="field-inline">
          <span>日付</span>
          <DateInput value={date} onChange={setDate} year={year} onKeyDown={nav} autoFocus={!entryId} aria-label="日付" disabled={adjustment} onValidity={(ok) => setDateBad(!ok)} />
        </label>
        <label className="check" title="年度末（12月31日）の決算整理仕訳として登録します。帳簿入力では 12月 のあとの「決算整理」に出ます">
          <input type="checkbox" checked={adjustment} onChange={(e) => toggleAdjustment(e.target.checked)} /> 決算整理仕訳
        </label>
        <span className="voucher-year">{year}年</span>
        <label className="field-inline">
          <span>取引先</span>
          <CounterpartyField value={counterpartyId} onChange={setCounterpartyId} onUnknown={setCpUnknown} onKeyDown={nav} aria-label="取引先" />
        </label>
        {entryId && <span className="voucher-no">伝票 No.{entryId}</span>}
      </div>

      <div className="table-wrap">
        <table className="ledger voucher-table">
          <colgroup>
            <col style={{ width: 36 }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: 136 }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: 136 }} />
            <col />
            <col style={{ width: 40 }} />
          </colgroup>
          <thead>
            <tr>
              <th />
              <th className="dr">借方科目</th>
              <th className="dr num">借方金額</th>
              <th className="tax-th">税区分</th>
              <th className="cr">貸方科目</th>
              <th className="cr num">貸方金額</th>
              <th className="tax-th">税区分</th>
              <th>摘要</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="row-no">{i + 1}</td>
                <td><AccountWithSub accountId={r.debitAccountId} subId={r.debitSubId} onAccount={(v) => update(i, { debitAccountId: v })} onSub={(v) => update(i, { debitSubId: v })} onKeyDown={nav} label={`${i + 1}行目 借方科目`} /></td>
                <td><AmountInput value={r.debitAmount} onChange={(v) => update(i, { debitAmount: v })} onKeyDown={nav} aria-label={`${i + 1}行目 借方金額`} /></td>
                <td>
                  <TaxSelect
                    label={`${i + 1}行目 借方税区分`} value={r.debitTax} invoice={r.debitInvoice} businessClass={r.debitClass} purchaseUse={r.debitUse} accountId={r.debitAccountId} side="debit"
                    date={date} counterpartyId={counterpartyId} onChange={(c, inv, k, u) => update(i, { debitTax: c, debitInvoice: inv, debitClass: k, debitUse: u })}
                  />
                  <TaxAmountField
                    label={`${i + 1}行目 借方消費税額`} amount={r.debitAmount} code={r.debitTax} invoice={r.debitInvoice} accountId={r.debitAccountId} side="debit"
                    date={date} counterpartyId={counterpartyId} value={r.debitTaxAmount} onChange={(v) => update(i, { debitTaxAmount: v })}
                  />
                </td>
                <td><AccountWithSub accountId={r.creditAccountId} subId={r.creditSubId} onAccount={(v) => update(i, { creditAccountId: v })} onSub={(v) => update(i, { creditSubId: v })} onKeyDown={nav} label={`${i + 1}行目 貸方科目`} /></td>
                <td><AmountInput value={r.creditAmount} onChange={(v) => update(i, { creditAmount: v })} onKeyDown={nav} aria-label={`${i + 1}行目 貸方金額`} /></td>
                <td>
                  <TaxSelect
                    label={`${i + 1}行目 貸方税区分`} value={r.creditTax} invoice={r.creditInvoice} businessClass={r.creditClass} purchaseUse={r.creditUse} accountId={r.creditAccountId} side="credit"
                    date={date} counterpartyId={counterpartyId} onChange={(c, inv, k, u) => update(i, { creditTax: c, creditInvoice: inv, creditClass: k, creditUse: u })}
                  />
                  <TaxAmountField
                    label={`${i + 1}行目 貸方消費税額`} amount={r.creditAmount} code={r.creditTax} invoice={r.creditInvoice} accountId={r.creditAccountId} side="credit"
                    date={date} counterpartyId={counterpartyId} value={r.creditTaxAmount} onChange={(v) => update(i, { creditTaxAmount: v })}
                  />
                </td>
                <td><MemoInput value={r.memo} onChange={(v) => update(i, { memo: v })} onCommit={(v) => fillFromMemo(i, v)} onKeyDown={nav} aria-label={`${i + 1}行目 摘要`} /></td>
                <td>
                  <button className="icon-btn subtle" tabIndex={-1} onClick={() => removeRow(i)} aria-label={`${i + 1}行目を消す`}>
                    <X size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td />
              <td className="total-label">借方合計</td>
              <td className="num">{yen(check.debitTotal)}</td>
              <td />
              <td className="total-label">貸方合計</td>
              <td className="num">{yen(check.creditTotal)}</td>
              <td />
              <td className={diff === 0 ? "balance-ok" : "balance-ng"}>
                {diff === 0 ? (check.debitTotal > 0 ? "貸借一致" : "") : `差額 ${yen(Math.abs(diff))}`}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {homeUse && homeUse.splits.length > 0 && (
        <div className="homeuse-split" role="status">
          {homeUse.splits.map((x, i) => (
            <div key={i} className={noSplit ? "muted" : "homeuse-hint"}>
              家事按分 {labelOf(x.account_id, null)} 事業 {x.rate}%：{yen(x.amount)} → 事業分 {yen(x.business)} ／ 事業主貸 {yen(x.private)}
              {noSplit ? "（分けません）" : " に分けて登録します"}
            </div>
          ))}
          <label className="check">
            <input type="checkbox" checked={noSplit} onChange={(e) => setNoSplit(e.target.checked)} />
            この伝票は按分しない（入力したとおりに登録する）
          </label>
        </div>
      )}

      {entryId && strict && (
        <label className="reason-field">
          <span>訂正・削除の理由（任意・履歴に残ります）</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：金額の入力誤り" maxLength={100} />
        </label>
      )}
      {late && (
        <label className="reason-field">
          <span>取引日から {inputDelayDays(date, todayIso())} 日後の登録で、入力期間（{inputDays} 日）を過ぎています。遅れた理由（任意・履歴に残ります）</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：領収書をあとから見つけた" maxLength={100} />
        </label>
      )}

      {errors.length > 0 && (
        <ul className="form-errors" role="alert">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}

      {locked && (
        <p className="closed-note" role="status">
          <Lock size={14} /> 締めた月の仕訳は、登録・訂正・削除できません。変更するには、事業者設定で締めを戻してください。
        </p>
      )}

      <div className="voucher-actions">
        <button className="btn ghost" onClick={() => setRows((rs) => [...rs, emptyRow()])}>
          <Plus size={16} /> 行を追加
        </button>
        {!entryId && (
          <>
            <button className="btn ghost" onClick={() => setPicking(true)}>
              <FileStack size={16} /> 定型仕訳から呼び出す
            </button>
            <button className="btn ghost" onClick={() => setSavingTemplate(true)} disabled={!hasInput} title={hasInput ? undefined : "伝票に入力してから登録できます"}>
              <BookmarkPlus size={16} /> 定型仕訳に登録
            </button>
          </>
        )}
        <div className="spacer" />
        {entryId && (
          <button className="btn danger-ghost" onClick={remove} disabled={locked}>
            <Trash2 size={16} /> 削除
          </button>
        )}
        {onCancel && <button className="btn ghost" onClick={onCancel}>閉じる</button>}
        <button className="btn primary" onClick={submit} disabled={saving || locked}>
          <Save size={16} /> {entryId ? "更新する" : "登録する"}
          <kbd>⌘↵</kbd>
        </button>
      </div>
      {picking && <TemplatePickModal onPick={pickTemplate} onClose={() => setPicking(false)} />}
      {savingTemplate && <TemplateSaveModal rows={rows} counterpartyId={counterpartyId} onClose={() => setSavingTemplate(false)} />}
    </div>
  );
};
